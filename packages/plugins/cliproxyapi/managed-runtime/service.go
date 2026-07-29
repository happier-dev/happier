package managedruntime

import (
	"context"
	"fmt"
	"net/http"
	"path/filepath"
	"sort"
	"sync"
	"time"

	sdkapi "github.com/router-for-me/CLIProxyAPI/v7/sdk/api"
	cliproxy "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

type Readiness struct {
	ContractVersion string             `json:"contractVersion"`
	SDKVersion      string             `json:"sdkVersion"`
	Protocols       []ProviderProtocol `json:"protocols"`
	Purposes        []QualifiedPurpose `json:"purposes"`
}

type CatalogModel struct {
	ID                         string   `json:"id"`
	Provider                   Provider `json:"provider"`
	DisplayName                string   `json:"displayName,omitempty"`
	AccountEntitlementVerified bool     `json:"accountEntitlementVerified"`
	Source                     string   `json:"source"`
}

type Gateway struct {
	config      Config
	service     *cliproxy.Service
	coreManager *coreauth.Manager
	ready       chan Readiness
	runMu       sync.Mutex
	running     bool
}

func NewGateway(
	config Config,
	runtimeIdentity RuntimeIdentity,
	broker RequestAuthBroker,
	upstream http.RoundTripper,
) (*Gateway, error) {
	return newGateway(config, runtimeIdentity, broker, upstream, nil)
}

func newGatewayForConformance(
	config Config,
	runtimeIdentity RuntimeIdentity,
	broker RequestAuthBroker,
	upstream http.RoundTripper,
	mutateAuth func(*coreauth.Auth),
) (*Gateway, error) {
	return newGateway(config, runtimeIdentity, broker, upstream, mutateAuth)
}

func newGateway(
	config Config,
	runtimeIdentity RuntimeIdentity,
	broker RequestAuthBroker,
	upstream http.RoundTripper,
	mutateAuth func(*coreauth.Auth),
) (*Gateway, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	if err := runtimeIdentity.validate(); err != nil {
		return nil, err
	}
	routes, err := servingRoutesForProtocols(
		config.Protocols,
		config.ModelListEnabled,
	)
	if err != nil {
		return nil, err
	}
	leaseProvider, err := newLeaseRoundTripperProvider(config.AuthEntries, broker, upstream)
	if err != nil {
		return nil, err
	}

	manager := coreauth.NewManager(nil, &coreauth.RoundRobinSelector{}, nil)
	manager.SetCooldownStateStore(nil)
	manager.SetRetryConfig(0, 0, 1)
	for _, entry := range config.AuthEntries {
		auth := managedRuntimeAuth(entry)
		if mutateAuth != nil {
			mutateAuth(auth)
		}
		if _, errRegister := manager.Register(coreauth.WithSkipPersist(context.Background()), auth); errRegister != nil {
			return nil, fmt.Errorf("register managed auth entry %q: %w", entry.ID, errRegister)
		}
	}

	upstreamConfig := managedSDKConfig(config)
	ready := make(chan Readiness, 1)
	service, err := cliproxy.NewBuilder().
		WithConfig(upstreamConfig).
		WithConfigPath(filepath.Join(config.RuntimeDir, "managed-config-not-persisted.yaml")).
		WithCoreAuthManager(manager).
		WithTokenClientProvider(emptyTokenClientProvider{}).
		WithAPIKeyClientProvider(emptyAPIKeyClientProvider{}).
		WithWatcherFactory(func(string, string, func(*sdkconfig.Config)) (*cliproxy.WatcherWrapper, error) {
			return &cliproxy.WatcherWrapper{}, nil
		}).
		WithServerOptions(sdkapi.WithMiddleware(
			StrictServingMiddleware(routes),
			ManagedHealthIdentityMiddleware(
				managedHealthIdentity(config, runtimeIdentity),
			),
		)).
		WithHooks(cliproxy.Hooks{
			OnAfterStart: func(*cliproxy.Service) {
				go publishReadinessAfterModelRegistration(config, ready)
			},
		}).
		Build()
	if err != nil {
		return nil, fmt.Errorf("build pinned CLIProxyAPI service: %w", err)
	}

	// Builder.Build installs its default provider unconditionally. The Happier
	// provider must therefore be installed after Build so it is the final
	// effective transport used after executor request shaping.
	manager.SetRoundTripperProvider(leaseProvider)
	manager.SetCooldownStateStore(nil)
	manager.SetRetryConfig(0, 0, 1)

	return &Gateway{
		config:      config,
		service:     service,
		coreManager: manager,
		ready:       ready,
	}, nil
}

func publishReadinessAfterModelRegistration(config Config, ready chan<- Readiness) {
	deadline := time.Now().Add(5 * time.Second)
	for {
		allRegistered := true
		for _, entry := range config.AuthEntries {
			if len(cliproxy.GlobalModelRegistry().GetAvailableModelsByProvider(string(entry.Provider))) == 0 {
				allRegistered = false
				break
			}
		}
		if allRegistered {
			select {
			case ready <- readinessForConfig(config):
			default:
			}
			return
		}
		if time.Now().After(deadline) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (g *Gateway) Ready() <-chan Readiness {
	if g == nil {
		return nil
	}
	return g.ready
}

func (g *Gateway) Run(ctx context.Context) error {
	if g == nil || g.service == nil {
		return fmt.Errorf("managed gateway is not initialized")
	}
	g.runMu.Lock()
	if g.running {
		g.runMu.Unlock()
		return fmt.Errorf("managed gateway is already running")
	}
	g.running = true
	g.runMu.Unlock()
	defer func() {
		for _, entry := range g.config.AuthEntries {
			cliproxy.GlobalModelRegistry().UnregisterClient(entry.ID)
		}
		g.runMu.Lock()
		g.running = false
		g.runMu.Unlock()
	}()
	return g.service.Run(ctx)
}

func (g *Gateway) Catalog() []CatalogModel {
	if g == nil {
		return nil
	}
	models := make([]CatalogModel, 0)
	for _, entry := range g.config.AuthEntries {
		for _, model := range cliproxy.GlobalModelRegistry().GetAvailableModelsByProvider(string(entry.Provider)) {
			if model == nil || model.ID == "" {
				continue
			}
			models = append(models, CatalogModel{
				ID:                         model.ID,
				Provider:                   entry.Provider,
				DisplayName:                model.DisplayName,
				AccountEntitlementVerified: false,
				Source:                     "cliproxyapi-sdk-static-compatibility",
			})
		}
	}
	sort.Slice(models, func(i, j int) bool {
		if models[i].Provider != models[j].Provider {
			return models[i].Provider < models[j].Provider
		}
		return models[i].ID < models[j].ID
	})
	return models
}

func managedSDKConfig(config Config) *sdkconfig.Config {
	cfg := &sdkconfig.Config{
		SDKConfig: sdkconfig.SDKConfig{
			APIKeys: config.DownstreamBearerValues(),
		},
		Host:                          config.Host,
		Port:                          config.Port,
		AuthDir:                       filepath.Join(config.RuntimeDir, "auth"),
		CommercialMode:                true,
		DisableCooling:                true,
		SaveCooldownStatus:            false,
		TransientErrorCooldownSeconds: -1,
		AuthAutoRefreshWorkers:        1,
		RequestRetry:                  0,
		MaxRetryCredentials:           1,
		MaxRetryInterval:              0,
		WebsocketAuth:                 true,
		DisableClaudeCloakMode:        true,
		RemoteManagement: sdkconfig.RemoteManagement{
			SecretKey:              "",
			AllowRemote:            false,
			DisableControlPanel:    true,
			DisableAutoUpdatePanel: true,
		},
	}
	cfg.Routing.Strategy = "round-robin"
	cfg.Routing.SessionAffinity = false
	cfg.Codex.IdentityConfuse = false
	return cfg
}

func (c Config) DownstreamBearerValues() []string {
	return []string{c.DownstreamBearer}
}

func managedRuntimeAuth(entry AuthEntry) *coreauth.Auth {
	attributes := map[string]string{
		coreauth.AttributeAuthKind:      coreauth.AuthKindOAuth,
		coreauth.AttributeRuntimeOnly:   "true",
		coreauth.AttributeSourceBackend: coreauth.AuthSourceMemory,
		"websockets":                    "false",
	}
	if entry.Provider == ProviderCodex {
		// This describes the SDK's widest static compatibility surface. Catalog
		// rows remain explicitly account-unverified and do not claim entitlement.
		attributes["plan_type"] = "pro"
	}
	registrationSentinel := "happier-registration-sentinel"
	if entry.Provider == ProviderClaude {
		// Keep the pinned executor on its subscription/OAuth translation path.
		registrationSentinel = "sk-ant-oat01-happier-registration-sentinel"
	}
	return &coreauth.Auth{
		ID:         entry.ID,
		Provider:   string(entry.Provider),
		Status:     coreauth.StatusActive,
		Attributes: attributes,
		Metadata: map[string]any{
			"access_token": registrationSentinel,
		},
		Runtime: neverRefreshRuntime{},
	}
}

type neverRefreshRuntime struct{}

func (neverRefreshRuntime) ShouldRefresh(time.Time, *coreauth.Auth) bool {
	return false
}

func readinessForConfig(config Config) Readiness {
	purposes := make([]QualifiedPurpose, 0, len(config.AuthEntries))
	for _, entry := range config.AuthEntries {
		purposes = append(purposes, entry.Purpose)
	}
	return Readiness{
		ContractVersion: WrapperContractVersion,
		SDKVersion:      PinnedSDKVersion,
		Protocols:       append([]ProviderProtocol(nil), config.Protocols...),
		Purposes:        purposes,
	}
}

type emptyTokenClientProvider struct{}

func (emptyTokenClientProvider) Load(context.Context, *sdkconfig.Config) (*cliproxy.TokenClientResult, error) {
	return &cliproxy.TokenClientResult{}, nil
}

type emptyAPIKeyClientProvider struct{}

func (emptyAPIKeyClientProvider) Load(context.Context, *sdkconfig.Config) (*cliproxy.APIKeyClientResult, error) {
	return &cliproxy.APIKeyClientResult{}, nil
}
