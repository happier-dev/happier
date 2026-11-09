package managedruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	sdkapi "github.com/router-for-me/CLIProxyAPI/v8/sdk/api"
	cliproxy "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

// This characterizes the integration blocker, rather than endorsing the SDK
// behavior. A public invocation wrapper is insufficient until the SDK exposes a
// synchronous registration decorator and a managed capability-probe opt-out.
func TestPinnedSDKStartupReplacesPublicWrappersAndProbesRegisteredAntigravity(t *testing.T) {
	t.Setenv("MANAGEMENT_PASSWORD", "")
	t.Setenv("HTTP_PROXY", "")
	t.Setenv("HTTPS_PROXY", "")
	t.Setenv("ALL_PROXY", "")
	var installed atomic.Bool
	probe := make(chan bool, 1)
	previousTransport := http.DefaultTransport
	// The network is the boundary fake: every SDK HTTP client receives a local
	// response; the real service, manager, registration and probe logic run.
	http.DefaultTransport = &startupProbeTransport{installed: &installed, probe: probe}
	t.Cleanup(func() { http.DefaultTransport = previousTransport })

	hook := &startupReapplicationHook{registered: make(map[string]bool), latest: make(map[string]*startupIdentityWrapper), predecessors: make(map[string][]coreauth.ProviderExecutor)}
	manager := coreauth.NewManager(nil, &coreauth.RoundRobinSelector{}, hook)
	hook.manager = manager
	providers := []string{"antigravity", "kimi", "xai", "devin"}
	for _, provider := range providers {
		// These deliberately unsupported families exercise the SDK's public
		// registration seam without adding them to Happier's active family rows.
		auth := &coreauth.Auth{ID: "startup-" + provider + ".json", Provider: provider,
			Status: coreauth.StatusActive, Runtime: neverRefreshRuntime{},
			Attributes: map[string]string{coreauth.AttributeRuntimeOnly: "true", "websockets": "false"},
			Metadata:   map[string]any{"access_token": "happier-registration-sentinel"}}
		// A unique project prevents another test's SDK capability cache from
		// satisfying this real startup registration without exercising its probe.
		if provider == "antigravity" {
			auth.Metadata["project_id"] = t.TempDir()
		}
		if _, err := manager.Register(coreauth.WithSkipPersist(context.Background()), auth); err != nil {
			t.Fatal(err)
		}
		if !hook.registered[auth.ID] {
			t.Fatalf("%s registration hook did not synchronously observe published auth", provider)
		}
	}
	cfg := managedSDKConfig(Config{Host: "127.0.0.1", Port: reserveLoopbackPort(t),
		RuntimeDir: t.TempDir(), DownstreamBearer: "fixture-downstream"})
	if cfg.QuotaExceeded.AntigravityCredits {
		t.Fatal("managed credits acquisition must stay disabled")
	}
	// Only this SDK fixture enables management, with an in-memory engine and
	// fake files under cfg.AuthDir. Happier's managed profile disables it.
	// The real upload handler reaches Service.runtimeAuthSyncHook; calling
	// Manager.Update directly would miss the service's executor replacement.
	cfg.RemoteManagement.SecretKey = "fixture-management"
	var engine *gin.Engine
	wrappers := make(map[string]*startupIdentityWrapper, len(providers))
	service, err := cliproxy.NewBuilder().
		WithConfig(cfg).
		WithConfigPath(filepath.Join(cfg.AuthDir, "not-persisted.yaml")).
		WithCoreAuthManager(manager).
		WithTokenClientProvider(emptyTokenClientProvider{}).
		WithAPIKeyClientProvider(emptyAPIKeyClientProvider{}).
		WithServerOptions(sdkapi.WithLocalManagementPassword("fixture-management"),
			sdkapi.WithEngineConfigurator(func(value *gin.Engine) { engine = value })).
		WithWatcherFactory(func(string, string, func(*sdkconfig.Config)) (*cliproxy.WatcherWrapper, error) {
			return &cliproxy.WatcherWrapper{}, nil
		}).
		WithHooks(cliproxy.Hooks{OnAfterStart: func(*cliproxy.Service) {
			for _, provider := range providers {
				executor, ok := manager.Executor(provider)
				if !ok || executor == nil {
					continue
				}
				wrapper := &startupIdentityWrapper{ProviderExecutor: executor}
				wrappers[provider] = wrapper
				manager.RegisterExecutor(wrapper)
			}
			installed.Store(true)
		}}).
		Build()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- service.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-result:
		case <-time.After(10 * time.Second):
			t.Error("SDK service did not stop after cancellation")
		}
		for _, provider := range providers {
			cliproxy.GlobalModelRegistry().UnregisterClient("startup-" + provider + ".json")
		}
	})
	select {
	case sentinelProbe := <-probe:
		if !sentinelProbe {
			t.Fatal("startup probe did not use the registered sentinel")
		}
	case err := <-result:
		result <- err
		t.Fatalf("SDK stopped before startup synchronization: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("startup synchronization did not reach the Antigravity probe")
	}
	service.WaitAntigravityProbes()
	for _, provider := range providers {
		wrapper := wrappers[provider]
		if wrapper == nil {
			t.Fatalf("OnAfterStart had no native executor for %s", provider)
		}
		if _, prepares := any(wrapper).(coreauth.RequestAuthPreparer); prepares {
			t.Fatal("public interface embedding unexpectedly promoted auth preparation")
		}
		current, ok := manager.Executor(provider)
		if !ok || current == nil || current == wrapper {
			t.Fatalf("%s no longer demonstrates the pinned SDK wrapper-overwrite blocker", provider)
		}
	}
	// Auth hooks are synchronous and reentrant after manager publication. They
	// can repair the service's auth-update registration, but are not called for
	// its executor-only startup synchronization or capability-probe dispatch.
	for _, provider := range providers {
		auth, ok := manager.GetByID("startup-" + provider + ".json")
		if !ok {
			t.Fatalf("missing %s fixture auth", provider)
		}
		metadata := auth.Metadata
		metadata["type"] = provider
		metadata["access_token"] = "happier-auth-update-sentinel"
		payload, err := json.Marshal(metadata)
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, "/v0/management/auth-files?name="+auth.ID, bytes.NewReader(payload))
		request.RemoteAddr = "127.0.0.1:12345"
		request.Header.Set("Authorization", "Bearer fixture-management")
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		engine.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("real SDK %s auth update failed: status %d, %s", provider, response.Code, response.Body.String())
		}
		hook.mu.Lock()
		latest := hook.latest[provider]
		predecessors := append([]coreauth.ProviderExecutor(nil), hook.predecessors[provider]...)
		hook.mu.Unlock()
		current, ok := manager.Executor(provider)
		if !ok || latest == nil || current != latest {
			t.Fatalf("%s wrapper did not survive the real service auth-update path", provider)
		}
		if len(predecessors) < 2 || predecessors[len(predecessors)-1] == predecessors[len(predecessors)-2] {
			t.Fatalf("%s update did not expose the service re-registration between manager hooks", provider)
		}
		for _, predecessor := range predecessors {
			if _, nestedWrapper := predecessor.(*startupIdentityWrapper); nestedWrapper {
				t.Fatalf("%s hook nested wrappers instead of observing native service re-registration", provider)
			}
		}
		t.Logf("%s: startup wrapper overwritten; real service auth update synchronously reapplied wrapper (%d hook callbacks)", provider, len(predecessors))
	}
	service.WaitAntigravityProbes()
}

type startupIdentityWrapper struct{ coreauth.ProviderExecutor }

type startupReapplicationHook struct {
	coreauth.NoopHook
	manager      *coreauth.Manager
	mu           sync.Mutex
	registered   map[string]bool
	latest       map[string]*startupIdentityWrapper
	predecessors map[string][]coreauth.ProviderExecutor
}

func (hook *startupReapplicationHook) OnAuthRegistered(_ context.Context, auth *coreauth.Auth) {
	_, published := hook.manager.GetByID(auth.ID)
	hook.mu.Lock()
	hook.registered[auth.ID] = published
	hook.mu.Unlock()
	hook.reapply(auth)
}

func (hook *startupReapplicationHook) OnAuthUpdated(_ context.Context, auth *coreauth.Auth) {
	hook.reapply(auth)
}

func (hook *startupReapplicationHook) reapply(auth *coreauth.Auth) {
	// Both operations reenter the real manager: a hook called before commit or
	// while holding the manager lock cannot satisfy this fixture.
	published, exists := hook.manager.GetByID(auth.ID)
	if !exists || published.Metadata["access_token"] != auth.Metadata["access_token"] {
		return
	}
	current, ok := hook.manager.Executor(auth.Provider)
	if !ok || current == nil {
		return
	}
	wrapper := &startupIdentityWrapper{ProviderExecutor: current}
	hook.manager.RegisterExecutor(wrapper)
	hook.mu.Lock()
	hook.latest[auth.Provider] = wrapper
	hook.predecessors[auth.Provider] = append(hook.predecessors[auth.Provider], current)
	hook.mu.Unlock()
}

type startupProbeTransport struct {
	installed *atomic.Bool
	probe     chan<- bool
}

func (transport *startupProbeTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	status := http.StatusServiceUnavailable
	if request.URL.Path == "/v1internal:fetchAvailableModels" {
		status = http.StatusOK
	}
	if status == http.StatusOK && transport.installed.Load() {
		select {
		case transport.probe <- request.Header.Get("Authorization") == "Bearer happier-registration-sentinel":
		default:
		}
	}
	return &http.Response{StatusCode: status, Header: make(http.Header),
		Body: io.NopCloser(strings.NewReader(`{"models":{}}`)), Request: request}, nil
}

func TestPinnedSelectorBucketsAndManagedOneEntryInvariant(t *testing.T) {
	t.Parallel()

	authA := &coreauth.Auth{ID: "a", Provider: "fixture", Status: coreauth.StatusActive}
	authB := &coreauth.Auth{ID: "b", Provider: "fixture", Status: coreauth.StatusActive}
	roundRobin := &coreauth.RoundRobinSelector{}

	first, err := roundRobin.Pick(context.Background(), "fixture", "model(high)", cliproxyexecutor.Options{}, []*coreauth.Auth{authA, authB})
	if err != nil {
		t.Fatalf("first Pick() error = %v", err)
	}
	second, err := roundRobin.Pick(context.Background(), "fixture", "model", cliproxyexecutor.Options{}, []*coreauth.Auth{authA, authB})
	if err != nil {
		t.Fatalf("second Pick() error = %v", err)
	}
	if first.ID != "a" || second.ID != "b" {
		t.Fatalf("canonical model bucket round-robin = %s then %s, want a then b", first.ID, second.ID)
	}

	for i := 0; i < 3; i++ {
		selected, errPick := roundRobin.Pick(context.Background(), "fixture", "another-model", cliproxyexecutor.Options{}, []*coreauth.Auth{authA})
		if errPick != nil || selected.ID != "a" {
			t.Fatalf("one-entry Pick() %d = %#v, %v", i, selected, errPick)
		}
	}

	fillFirst := &coreauth.FillFirstSelector{}
	for i, model := range []string{"model(high)", "model"} {
		selected, errPick := fillFirst.Pick(
			context.Background(),
			"fixture",
			model,
			cliproxyexecutor.Options{},
			[]*coreauth.Auth{authB, authA},
		)
		if errPick != nil || selected.ID != "a" {
			t.Fatalf("fill-first Pick() %d = %#v, %v; want deterministic first eligible entry a", i, selected, errPick)
		}
	}
}

func TestPinnedSessionAffinityUsesProviderSessionAndCanonicalModelBucket(t *testing.T) {
	t.Parallel()

	fallback := &recordingSelector{
		sequence: []*coreauth.Auth{
			{ID: "a", Provider: "fixture", Status: coreauth.StatusActive},
			{ID: "b", Provider: "fixture", Status: coreauth.StatusActive},
			{ID: "c", Provider: "other-fixture", Status: coreauth.StatusActive},
			{ID: "d", Provider: "other-fixture", Status: coreauth.StatusActive},
		},
	}
	selector := coreauth.NewSessionAffinitySelector(fallback)
	t.Cleanup(selector.Stop)
	auths := fallback.sequence
	opts := cliproxyexecutor.Options{Headers: http.Header{"X-Session-Id": {"session-1"}}}

	first, err := selector.Pick(context.Background(), "fixture", "model(high)", opts, auths)
	if err != nil {
		t.Fatalf("first affinity Pick() error = %v", err)
	}
	repeated, err := selector.Pick(context.Background(), "fixture", "model(high)", opts, auths)
	if err != nil {
		t.Fatalf("repeated affinity Pick() error = %v", err)
	}
	canonicalModel, err := selector.Pick(context.Background(), "fixture", "model", opts, auths)
	if err != nil {
		t.Fatalf("canonical-model affinity Pick() error = %v", err)
	}
	otherModel, err := selector.Pick(context.Background(), "fixture", "another-model", opts, auths)
	if err != nil {
		t.Fatalf("other-model affinity Pick() error = %v", err)
	}
	otherProvider, err := selector.Pick(context.Background(), "other-fixture", "model(high)", opts, auths)
	if err != nil {
		t.Fatalf("other-provider affinity Pick() error = %v", err)
	}
	if first.ID != "a" || repeated.ID != "a" || canonicalModel.ID != "a" || otherModel.ID != "b" || otherProvider.ID != "c" {
		t.Fatalf(
			"session-affinity picks = %s, %s, %s, %s, %s; want a, a, a, b, c",
			first.ID,
			repeated.ID,
			canonicalModel.ID,
			otherModel.ID,
			otherProvider.ID,
		)
	}
	if fallback.calls != 3 {
		t.Fatalf("fallback calls = %d, want canonical-model reuse and distinct provider buckets", fallback.calls)
	}
}

func TestPinnedManagerRetryCooldownAndRefreshAreBehaviorallyInert(t *testing.T) {
	configurePinnedCooldownPolicy(t)

	executor := &recordingExecutor{
		executeErrors: []error{
			&coreauth.Error{HTTPStatus: http.StatusTooManyRequests, Message: "fixture quota"},
			nil,
		},
	}
	manager := coreauth.NewManager(nil, &coreauth.RoundRobinSelector{}, nil)
	manager.SetCooldownStateStore(nil)
	manager.SetRetryConfig(0, 0, 1)
	manager.RegisterExecutor(executor)
	auth := &coreauth.Auth{
		ID:       "logical-entry",
		Provider: executor.Identifier(),
		Status:   coreauth.StatusActive,
		Attributes: map[string]string{
			coreauth.AttributeAuthKind:    coreauth.AuthKindOAuth,
			coreauth.AttributeRuntimeOnly: "true",
		},
		Runtime: neverRefreshRuntime{},
	}
	if _, err := manager.Register(coreauth.WithSkipPersist(context.Background()), auth); err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	_, firstErr := manager.Execute(context.Background(), []string{executor.Identifier()}, cliproxyexecutor.Request{}, cliproxyexecutor.Options{})
	if firstErr == nil {
		t.Fatal("first Execute() error = nil, want fixture quota")
	}
	if executor.executeCalls() != 1 {
		t.Fatalf("first Execute() calls = %d, want zero hidden retry", executor.executeCalls())
	}
	if _, secondErr := manager.Execute(context.Background(), []string{executor.Identifier()}, cliproxyexecutor.Request{}, cliproxyexecutor.Options{}); secondErr != nil {
		t.Fatalf("second independent Execute() remained cooled down: %v", secondErr)
	}
	if executor.executeCalls() != 2 {
		t.Fatalf("second Execute() total calls = %d, want 2", executor.executeCalls())
	}

	manager.StartAutoRefresh(context.Background(), 10*time.Millisecond)
	time.Sleep(80 * time.Millisecond)
	manager.StopAutoRefresh()
	if executor.refreshCalls() != 0 {
		t.Fatalf("auto-refresh executor calls = %d, want behaviorally inert runtime entry", executor.refreshCalls())
	}
}

func TestPinnedManagerStreamBootstrapReplayAndRefreshAreBehaviorallyInert(t *testing.T) {
	configurePinnedCooldownPolicy(t)

	executor := &recordingExecutor{
		streamErrors: []error{
			&coreauth.Error{HTTPStatus: http.StatusUnauthorized, Message: "fixture unauthorized bootstrap"},
			nil,
		},
	}
	manager := coreauth.NewManager(nil, &coreauth.RoundRobinSelector{}, nil)
	manager.SetCooldownStateStore(nil)
	manager.SetRetryConfig(0, 0, 1)
	manager.RegisterExecutor(executor)
	auth := &coreauth.Auth{
		ID:       "logical-entry",
		Provider: executor.Identifier(),
		Status:   coreauth.StatusActive,
		Attributes: map[string]string{
			coreauth.AttributeAuthKind:    coreauth.AuthKindOAuth,
			coreauth.AttributeRuntimeOnly: "true",
		},
		Runtime: neverRefreshRuntime{},
	}
	if _, err := manager.Register(coreauth.WithSkipPersist(context.Background()), auth); err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	result, err := manager.ExecuteStream(
		context.Background(),
		[]string{executor.Identifier()},
		cliproxyexecutor.Request{},
		cliproxyexecutor.Options{},
	)
	if err != nil {
		t.Fatalf("ExecuteStream() error = %v", err)
	}
	if result == nil {
		t.Fatal("ExecuteStream() result = nil")
	}
	var bootstrapErr error
	for chunk := range result.Chunks {
		if chunk.Err != nil {
			bootstrapErr = chunk.Err
		}
	}
	if bootstrapErr == nil {
		t.Fatal("stream bootstrap error was not surfaced")
	}
	if executor.streamCalls() != 1 {
		t.Fatalf("ExecuteStream() calls = %d, want zero hidden bootstrap replay", executor.streamCalls())
	}
	if executor.refreshCalls() != 0 {
		t.Fatalf("bootstrap failure refresh calls = %d, want no native refresh effect", executor.refreshCalls())
	}
}

func configurePinnedCooldownPolicy(t *testing.T) {
	t.Helper()
	coreauth.SetQuotaCooldownDisabled(true)
	coreauth.SetTransientErrorCooldownSeconds(-1)
	t.Cleanup(func() {
		coreauth.SetQuotaCooldownDisabled(false)
		coreauth.SetTransientErrorCooldownSeconds(0)
	})
}

type recordingSelector struct {
	sequence []*coreauth.Auth
	calls    int
}

func (s *recordingSelector) Pick(context.Context, string, string, cliproxyexecutor.Options, []*coreauth.Auth) (*coreauth.Auth, error) {
	selected := s.sequence[s.calls%len(s.sequence)]
	s.calls++
	return selected, nil
}

type recordingExecutor struct {
	mu            sync.Mutex
	executeErrors []error
	streamErrors  []error
	executes      int
	streams       int
	refreshes     int
}

func (e *recordingExecutor) Identifier() string { return "fixture" }

func (e *recordingExecutor) Execute(context.Context, *coreauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	index := e.executes
	e.executes++
	if index < len(e.executeErrors) {
		return cliproxyexecutor.Response{}, e.executeErrors[index]
	}
	return cliproxyexecutor.Response{}, nil
}

func (e *recordingExecutor) ExecuteStream(context.Context, *coreauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	e.mu.Lock()
	index := e.streams
	e.streams++
	var streamErr error
	if index < len(e.streamErrors) {
		streamErr = e.streamErrors[index]
	}
	e.mu.Unlock()

	chunks := make(chan cliproxyexecutor.StreamChunk, 1)
	if streamErr != nil {
		chunks <- cliproxyexecutor.StreamChunk{Err: streamErr}
	} else {
		chunks <- cliproxyexecutor.StreamChunk{Payload: []byte(`{"fixture":"ok"}`)}
	}
	close(chunks)
	return &cliproxyexecutor.StreamResult{Chunks: chunks}, nil
}

func (e *recordingExecutor) Refresh(_ context.Context, auth *coreauth.Auth) (*coreauth.Auth, error) {
	e.mu.Lock()
	e.refreshes++
	e.mu.Unlock()
	return auth, nil
}

func (e *recordingExecutor) CountTokens(context.Context, *coreauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return cliproxyexecutor.Response{}, nil
}

func (e *recordingExecutor) HttpRequest(context.Context, *coreauth.Auth, *http.Request) (*http.Response, error) {
	return nil, nil
}

func (e *recordingExecutor) executeCalls() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.executes
}

func (e *recordingExecutor) refreshCalls() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.refreshes
}

func (e *recordingExecutor) streamCalls() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.streams
}
