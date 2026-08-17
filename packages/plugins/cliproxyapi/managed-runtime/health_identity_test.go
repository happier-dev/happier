package managedruntime

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestManagedHealthIdentityMiddlewareReplacesSDKStatusWithExactTokenFreeLaunchIdentity(t *testing.T) {
	t.Parallel()

	config := Config{
		Host:             "127.0.0.1",
		Port:             32123,
		DownstreamBearer: "downstream-secret-must-not-leak",
		RuntimeDir:       "/private/runtime-path-must-not-leak",
		AuthEntries: []AuthEntry{
			testAuthEntry("codex", ProviderCodex, "openai-upstream"),
			testAuthEntry("claude", ProviderClaude, "anthropic-upstream"),
		},
		Protocols:        []ProviderProtocol{ProtocolOpenAIResponses, ProtocolAnthropic},
		ModelListEnabled: true,
	}
	identity := RuntimeIdentity{
		WrapperBuildVersion: "1.2.3",
	}
	body := requestManagedHealthIdentity(t, config, identity, http.MethodGet)

	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		t.Fatalf("decode health identity: %v; body=%s", err, body)
	}
	wantKeys := []string{
		"v",
		"contractVersion",
		"sdkVersion",
		"wrapperBuildVersion",
		"protocols",
		"purposes",
		"modelListEnabled",
	}
	gotKeys := make([]string, 0, len(fields))
	for key := range fields {
		gotKeys = append(gotKeys, key)
	}
	if !sameStringSet(gotKeys, wantKeys) {
		t.Fatalf("health identity keys = %#v, want exactly %#v", gotKeys, wantKeys)
	}

	var got ManagedHealthIdentity
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode typed health identity: %v", err)
	}
	want := ManagedHealthIdentity{
		V:                   1,
		ContractVersion:     WrapperContractVersion,
		SDKVersion:          PinnedSDKVersion,
		WrapperBuildVersion: "1.2.3",
		Protocols:           []ProviderProtocol{ProtocolOpenAIResponses, ProtocolAnthropic},
		Purposes: []QualifiedPurpose{
			testPurpose("openai-upstream"),
			testPurpose("anthropic-upstream"),
		},
		ModelListEnabled: true,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("health identity = %#v, want %#v", got, want)
	}
	serialized := string(body)
	for _, forbidden := range []string{
		config.DownstreamBearer,
		config.RuntimeDir,
		"codex",
		"claude",
		"status",
	} {
		if strings.Contains(serialized, forbidden) {
			t.Fatalf("health identity leaked forbidden value %q: %s", forbidden, serialized)
		}
	}
}

func TestManagedHealthIdentityWithholdsReadinessUntilTheConfiguredModelsRegister(t *testing.T) {
	t.Parallel()

	registered := false
	identity := managedHealthIdentity(Config{
		Host:             "127.0.0.1",
		Port:             32123,
		DownstreamBearer: "secret",
		RuntimeDir:       "/private/runtime",
		AuthEntries: []AuthEntry{
			testAuthEntry("codex", ProviderCodex, "openai-upstream"),
		},
		Protocols: []ProviderProtocol{ProtocolOpenAIResponses},
	}, testRuntimeIdentity())
	router := gin.New()
	router.Use(ManagedHealthIdentityMiddleware(identity, func() bool {
		return registered
	}))
	router.GET("/healthz", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})

	notReady := httptest.NewRecorder()
	router.ServeHTTP(notReady, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if notReady.Code != http.StatusServiceUnavailable {
		t.Fatalf("unregistered model health status = %d, want 503", notReady.Code)
	}
	if strings.Contains(notReady.Body.String(), identity.WrapperBuildVersion) {
		t.Fatalf("unready health response disclosed launch identity: %s", notReady.Body.String())
	}

	registered = true
	ready := httptest.NewRecorder()
	router.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if ready.Code != http.StatusOK {
		t.Fatalf("registered model health status = %d, want 200", ready.Code)
	}
}

func TestManagedHealthIdentityCarriesDiagnosticBuildLabelAndBindsServingFacts(t *testing.T) {
	t.Parallel()

	baseConfig := Config{
		Host:             "127.0.0.1",
		Port:             32123,
		DownstreamBearer: "secret",
		RuntimeDir:       "/private/runtime",
		AuthEntries: []AuthEntry{
			testAuthEntry("codex", ProviderCodex, "openai-upstream"),
		},
		Protocols: []ProviderProtocol{ProtocolOpenAIResponses},
	}
	baseIdentity := RuntimeIdentity{
		WrapperBuildVersion: "1.2.3",
	}
	baseline := string(requestManagedHealthIdentity(
		t,
		baseConfig,
		baseIdentity,
		http.MethodGet,
	))
	testCases := []struct {
		name     string
		config   Config
		identity RuntimeIdentity
	}{
		{
			name:   "different diagnostic wrapper build",
			config: baseConfig,
			identity: RuntimeIdentity{
				WrapperBuildVersion: "1.2.2",
			},
		},
		{
			name: "wrong protocol",
			config: func() Config {
				value := baseConfig
				value.Protocols = []ProviderProtocol{ProtocolOpenAIChat}
				return value
			}(),
			identity: baseIdentity,
		},
		{
			name: "wrong purpose",
			config: func() Config {
				value := baseConfig
				value.AuthEntries = []AuthEntry{
					testAuthEntry("codex", ProviderCodex, "openai-other"),
				}
				return value
			}(),
			identity: baseIdentity,
		},
		{
			name: "wrong serving config",
			config: func() Config {
				value := baseConfig
				value.ModelListEnabled = true
				return value
			}(),
			identity: baseIdentity,
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			got := string(requestManagedHealthIdentity(
				t,
				testCase.config,
				testCase.identity,
				http.MethodGet,
			))
			if got == baseline {
				t.Fatalf("changed diagnostic or serving fact did not change health identity: %s", got)
			}
		})
	}
}

func TestManagedHealthIdentityHeadHasNoBody(t *testing.T) {
	t.Parallel()

	body := requestManagedHealthIdentity(
		t,
		Config{
			Host:             "127.0.0.1",
			Port:             32123,
			DownstreamBearer: "secret",
			RuntimeDir:       "/private/runtime",
			AuthEntries: []AuthEntry{
				testAuthEntry("codex", ProviderCodex, "openai-upstream"),
			},
			Protocols: []ProviderProtocol{ProtocolOpenAIResponses},
		},
		RuntimeIdentity{
			WrapperBuildVersion: "1.2.3",
		},
		http.MethodHead,
	)
	if len(body) != 0 {
		t.Fatalf("HEAD /healthz body = %q, want empty", body)
	}
}

func TestRuntimeIdentityRejectsMissingOrMalformedBuildFact(t *testing.T) {
	t.Parallel()

	valid := testRuntimeIdentity()
	if err := valid.validate(); err != nil {
		t.Fatalf("valid runtime identity rejected: %v", err)
	}
	for _, invalid := range []RuntimeIdentity{
		{},
		{
			WrapperBuildVersion: " 1.2.3 ",
		},
		{
			WrapperBuildVersion: strings.Repeat("v", 129),
		},
	} {
		if err := invalid.validate(); err == nil {
			t.Fatalf("invalid runtime identity accepted: %#v", invalid)
		}
	}
}

func testRuntimeIdentity() RuntimeIdentity {
	return RuntimeIdentity{
		WrapperBuildVersion: "1.2.3-test",
	}
}

func requestManagedHealthIdentity(
	t *testing.T,
	config Config,
	identity RuntimeIdentity,
	method string,
) []byte {
	t.Helper()
	router := gin.New()
	router.Use(ManagedHealthIdentityMiddleware(
		managedHealthIdentity(config, identity),
		func() bool { return true },
	))
	router.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	router.HEAD("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(method, "/healthz", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("%s /healthz status = %d", method, recorder.Code)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("%s /healthz content type = %q", method, got)
	}
	return recorder.Body.Bytes()
}

func sameStringSet(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	values := make(map[string]struct{}, len(left))
	for _, value := range left {
		values[value] = struct{}{}
	}
	for _, value := range right {
		if _, ok := values[value]; !ok {
			return false
		}
	}
	return true
}
