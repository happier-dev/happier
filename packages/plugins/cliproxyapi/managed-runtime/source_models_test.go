package managedruntime

import (
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	cliproxy "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
)

// Characterize the pinned public SDK before connecting the host observation.
// Both the HTTP router/executor and its final transport remain real; only the
// credential broker and vendor HTTP boundary are controlled fixtures.
func TestPinnedSDKExplicitModelRegistrationRoutesExactIDs(t *testing.T) {
	cfg := Config{
		Host: "127.0.0.1", Port: reserveLoopbackPort(t), RuntimeDir: t.TempDir(),
		DownstreamBearer: "controlled-downstream",
		AuthEntries:      []AuthEntry{testAuthEntry("codex", ProviderCodex, "openai-upstream")},
		Protocols:        []ProviderProtocol{ProtocolOpenAIResponses}, ModelListEnabled: true,
	}
	broker := &sequenceBroker{leases: []RequestAuthHeaders{validLease("controlled-source", nil)}}
	upstream := &protocolFixtureRoundTripper{}
	gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
	if err != nil {
		t.Fatal(err)
	}
	cancel, result := runGateway(t, gateway)
	defer stopGateway(t, cancel, result)
	awaitManagedHealthIdentity(t, cfg)

	cliproxy.GlobalModelRegistry().RegisterClient(cfg.AuthEntries[0].ID, string(ProviderCodex), []*cliproxy.ModelInfo{
		{ID: "gpt-6.1-sol", Object: "model", Type: string(ProviderCodex), OwnedBy: "openai", UserDefined: true},
	})
	response := postJSON(t, cfg, "/v1/responses", `{"model":"gpt-6.1-sol","input":"controlled probe"}`)
	body := readResponse(t, response)
	requests := upstream.requests()
	if response.StatusCode != http.StatusOK || len(requests) != 1 || len(broker.purposes()) != 1 {
		t.Fatalf("observed model status=%d upstream=%d credential_lookups=%d body=%s", response.StatusCode, len(requests), len(broker.purposes()), body)
	}
	requestBody, err := io.ReadAll(requests[0].Body)
	if err != nil || !strings.Contains(string(requestBody), `"model":"gpt-6.1-sol"`) {
		t.Fatalf("the native model id was not preserved: %s, %v", requestBody, err)
	}
	t.Logf("observed model=gpt-6.1-sol status=%d upstream_requests=1 unchanged_model_id=true", response.StatusCode)

	// Replacement, rather than union with the pinned catalog, withdraws an
	// otherwise registered model before credentials or upstream can be used.
	response = postJSON(t, cfg, "/v1/responses", `{"model":"gpt-6-astra","input":"must not route"}`)
	body = readResponse(t, response)
	if response.StatusCode == http.StatusOK || len(upstream.requests()) != 1 || len(broker.purposes()) != 1 {
		t.Fatalf("unobserved model status=%d upstream=%d credential_lookups=%d body=%s", response.StatusCode, len(upstream.requests()), len(broker.purposes()), body)
	}
	t.Logf("unobserved model=gpt-6-astra status=%d additional_upstream_requests=0 additional_credential_lookups=0", response.StatusCode)
}

func TestObservedConsumerModelsRouteWithoutAdmittingAnotherSource(t *testing.T) {
	runtimeDir := t.TempDir()
	accessPath := filepath.Join(runtimeDir, "consumers.json")
	purpose := testPurpose("openai-upstream")
	consumer := func(token, modelID string) map[string]any {
		return map[string]any{
			"token": token, "capabilityPath": filepath.Join(runtimeDir, "capability.json"),
			"purposes": []QualifiedPurpose{purpose},
			"modelCatalogs": []map[string]any{{"purpose": purpose, "sourceRevision": modelID,
				"models": []map[string]any{{"id": modelID}}}},
		}
	}
	one := consumer(testCapability(81), "gpt-6.1-sol")
	two := consumer(testCapability(82), "gpt-6.1-terra")
	writeConsumerAccess(t, accessPath, one, two)
	cfg := Config{Host: "127.0.0.1", Port: reserveLoopbackPort(t), RuntimeDir: runtimeDir,
		DownstreamBearer: "physical-health-only", ConsumerAccessPath: accessPath,
		AuthEntries: []AuthEntry{testAuthEntry("codex", ProviderCodex, "openai-upstream")},
		Protocols:   []ProviderProtocol{ProtocolOpenAIResponses}, ModelListEnabled: true}
	broker := &sequenceBroker{leases: []RequestAuthHeaders{validLease("controlled-one", nil), validLease("controlled-two", nil)}}
	upstream := &protocolFixtureRoundTripper{}
	gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
	if err != nil {
		t.Fatal(err)
	}
	cancel, result := runGateway(t, gateway)
	defer stopGateway(t, cancel, result)
	awaitManagedHealthIdentity(t, cfg)
	consumerConfig := cfg
	consumerConfig.DownstreamBearer = testCapability(83)
	response := postJSON(t, consumerConfig, "/v1/responses", `{"model":"gpt-6.1-sol","input":"wrong audience"}`)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized || len(upstream.requests()) != 0 || len(broker.purposes()) != 0 || len(gateway.coreManager.List()) != 1 {
		t.Fatal("unknown audience installed a source client or reached the source")
	}
	consumerConfig.DownstreamBearer = testCapability(81)
	response = postJSON(t, consumerConfig, "/v1/responses", `{"model":"gpt-6.1-sol","input":"observed"}`)
	body := readResponse(t, response)
	if response.StatusCode != http.StatusOK || len(upstream.requests()) != 1 {
		t.Fatalf("observed model status=%d upstream=%d body=%s", response.StatusCode, len(upstream.requests()), body)
	}
	// The second source can serve its own different observation in the same
	// physical gateway; registering it must never widen the first source.
	consumerConfig.DownstreamBearer = testCapability(82)
	response = postJSON(t, consumerConfig, "/v1/responses", `{"model":"gpt-6.1-terra","input":"other source"}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("second source status=%d body=%s", response.StatusCode, readResponse(t, response))
	}
	_ = response.Body.Close()
	consumerConfig.DownstreamBearer = testCapability(81)
	for _, unobserved := range []string{"gpt-6-astra", "gpt-6.1-terra"} {
		response = postJSON(t, consumerConfig, "/v1/responses", `{"model":"`+unobserved+`","input":"not admitted"}`)
		body = readResponse(t, response)
		if response.StatusCode == http.StatusOK || len(upstream.requests()) != 2 || len(broker.purposes()) != 2 {
			t.Fatalf("unobserved model=%s status=%d upstream=%d credential_lookups=%d body=%s", unobserved, response.StatusCode, len(upstream.requests()), len(broker.purposes()), body)
		}
	}
	models := getStrictOpenAIModelCatalog(t, consumerConfig)
	if len(models) != 1 || string(models[0]["id"]) != `"gpt-6.1-sol"` {
		t.Fatalf("source model surface disagrees: %#v", models)
	}
	if len(gateway.coreManager.List()) != 3 {
		t.Fatal("requests or catalog presentation registered duplicate SDK source clients")
	}
	writeConsumerAccess(t, accessPath, consumer(testCapability(81), "changed-source-model"), two)
	response = postJSON(t, consumerConfig, "/v1/responses", `{"model":"gpt-6.1-sol","input":"source changed"}`)
	_ = response.Body.Close()
	if response.StatusCode < 400 || len(upstream.requests()) != 2 || len(broker.purposes()) != 2 {
		t.Fatal("a changed source observation retained use of its old client")
	}
	writeConsumerAccess(t, accessPath, two)
	response = postJSON(t, consumerConfig, "/v1/responses", `{"model":"gpt-6.1-sol","input":"revoked"}`)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized || len(upstream.requests()) != 2 || len(broker.purposes()) != 2 {
		t.Fatalf("revoked source status=%d upstream=%d credential_lookups=%d", response.StatusCode, len(upstream.requests()), len(broker.purposes()))
	}
	response = postJSON(t, cfg, ConsumerAccessSettlementPath, `{"token":"`+testCapability(81)+`"}`)
	_ = response.Body.Close()
	_, retained := gateway.coreManager.GetByID(sourceModelClientID(testCapability(81), cfg.AuthEntries[0].ID))
	if response.StatusCode != http.StatusOK || retained || len(gateway.coreManager.List()) != 2 {
		t.Fatal("settlement failed to release exactly the retired source's SDK client")
	}
	consumerConfig.DownstreamBearer = testCapability(82)
	if models = getStrictOpenAIModelCatalog(t, consumerConfig); len(models) != 1 || string(models[0]["id"]) != `"gpt-6.1-terra"` {
		t.Fatal("settling one source withdrew the other consumer's catalog")
	}
}
