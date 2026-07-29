package managedruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/iotest"
	"time"

	"github.com/gorilla/websocket"
	sdkhandlers "github.com/router-for-me/CLIProxyAPI/v7/sdk/api/handlers"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

func TestPinnedSDKMixedServingUsesFinalLeaseAfterExecutorShaping(t *testing.T) {
	t.Setenv("MANAGEMENT_PASSWORD", "ambient-management-secret-must-stay-unreachable")
	port := reserveLoopbackPort(t)
	runtimeDir := t.TempDir()
	cfg := Config{
		Host:             "127.0.0.1",
		Port:             port,
		DownstreamBearer: "downstream-session-bearer",
		RuntimeDir:       runtimeDir,
		AuthEntries: []AuthEntry{
			{ID: "codex", Provider: ProviderCodex, Purpose: testPurpose("openai-upstream")},
			{ID: "claude", Provider: ProviderClaude, Purpose: testPurpose("anthropic-upstream")},
		},
		Protocols: []ProviderProtocol{
			ProtocolOpenAIResponses,
			ProtocolAnthropic,
		},
		ModelListEnabled: true,
	}
	broker := &sequenceBroker{leases: []OAuthBearerLease{
		validLease("codex-current", map[string]string{"Chatgpt-Account-Id": "account-current"}),
		validLease("claude-current", nil),
	}}
	upstream := &protocolFixtureRoundTripper{}
	gateway, err := newGatewayForConformance(cfg, testRuntimeIdentity(), broker, upstream, func(auth *coreauth.Auth) {
		auth.Metadata["account_id"] = "stale-registration-account"
		auth.Metadata["access_token"] = "stale-registration-token"
	})
	if err != nil {
		t.Fatalf("newGatewayForConformance() error = %v", err)
	}
	cancel, runResult := runGateway(t, gateway)
	defer stopGateway(t, cancel, runResult)

	readiness := awaitReadiness(t, gateway)
	if readiness.ContractVersion != WrapperContractVersion || readiness.SDKVersion != PinnedSDKVersion {
		t.Fatalf("readiness versions = %#v", readiness)
	}
	if len(readiness.Protocols) != 2 ||
		readiness.Protocols[0] != ProtocolOpenAIResponses ||
		readiness.Protocols[1] != ProtocolAnthropic {
		t.Fatalf("readiness protocols = %#v", readiness.Protocols)
	}
	healthIdentity := getManagedHealthIdentity(t, cfg)
	if healthIdentity.WrapperBuildVersion != testRuntimeIdentity().WrapperBuildVersion ||
		healthIdentity.MaterializationID != testRuntimeIdentity().MaterializationID ||
		!healthIdentity.ModelListEnabled ||
		len(healthIdentity.Protocols) != 2 ||
		len(healthIdentity.Purposes) != 2 {
		t.Fatalf("managed health identity = %#v", healthIdentity)
	}
	catalog := gateway.Catalog()
	if !catalogContains(catalog, ProviderCodex, "gpt-5.5") {
		t.Fatal("credential-free catalog omitted pinned Codex compatibility model")
	}
	if !catalogContains(catalog, ProviderClaude, "claude-sonnet-4-6") {
		t.Fatal("credential-free catalog omitted pinned Claude compatibility model")
	}
	for _, model := range catalog {
		if model.AccountEntitlementVerified {
			t.Fatalf("catalog model %s incorrectly claims account entitlement", model.ID)
		}
	}
	if got := len(broker.purposes()); got != 0 {
		t.Fatalf("catalog performed %d credential lookups, want credential-free static SDK source", got)
	}
	httpCatalog := getStrictOpenAIModelCatalog(t, cfg)
	assertCatalogMatchesRegisteredModels(t, httpCatalog, catalog)
	if got := len(broker.purposes()); got != 0 {
		t.Fatalf("HTTP model catalog performed %d credential lookups, want credential-free static SDK source", got)
	}

	codexResponse := postJSON(t, cfg, "/v1/responses", `{"model":"gpt-5.5","input":"hello"}`)
	if codexResponse.StatusCode != http.StatusOK {
		t.Fatalf("Codex downstream status = %d, body=%s", codexResponse.StatusCode, readResponse(t, codexResponse))
	}
	_ = codexResponse.Body.Close()

	claudeResponse := postJSON(t, cfg, "/v1/messages", `{"model":"claude-sonnet-4-6","max_tokens":16,"messages":[{"role":"user","content":"hello"}]}`)
	if claudeResponse.StatusCode != http.StatusOK {
		t.Fatalf("Claude downstream status = %d, body=%s", claudeResponse.StatusCode, readResponse(t, claudeResponse))
	}
	_ = claudeResponse.Body.Close()

	requests := upstream.requests()
	if len(requests) != 2 {
		t.Fatalf("upstream requests = %d, want 2", len(requests))
	}
	if got := requests[0].Header.Get("Authorization"); got != "Bearer codex-current" {
		t.Fatalf("Codex final Authorization = %q", got)
	}
	if got := requests[0].URL.String(); got != "https://chatgpt.com/backend-api/codex/responses" {
		t.Fatalf("Codex final upstream URL = %q", got)
	}
	if got := requests[0].Header.Get("Chatgpt-Account-Id"); got != "account-current" {
		t.Fatalf("Codex final account header = %q", got)
	}
	if strings.Contains(requests[0].Header.Get("Authorization"), "stale") {
		t.Fatal("Codex registration-time token survived final transport")
	}
	if got := requests[1].Header.Get("Authorization"); got != "Bearer claude-current" {
		t.Fatalf("Claude final Authorization = %q", got)
	}
	if got := requests[1].Header.Get("X-Api-Key"); got != "" {
		t.Fatalf("Claude stale executor API key survived = %q", got)
	}
	if got := requests[1].Header.Get("X-Claude-Code-Session-Id"); got != "" {
		t.Fatalf("Claude credential-derived session identity survived = %q", got)
	}
	if got := requests[1].Header.Get("Chatgpt-Account-Id"); got != "" {
		t.Fatalf("Claude inherited stale Codex account identity = %q", got)
	}

	assertStrictSurface(t, cfg, http.MethodGet, "/v0/management/config")
	assertStrictSurface(t, cfg, http.MethodGet, "/management.html")
	assertStrictSurface(t, cfg, http.MethodGet, "/codex/callback")
	assertStrictSurface(t, cfg, http.MethodGet, "/")

	assertNoRuntimeStateFiles(t, runtimeDir)
}

func TestPinnedSDKDoesNotReplayOrCoolDownManagedEntry(t *testing.T) {
	port := reserveLoopbackPort(t)
	cfg := Config{
		Host:             "127.0.0.1",
		Port:             port,
		DownstreamBearer: "downstream-session-bearer",
		RuntimeDir:       t.TempDir(),
		AuthEntries: []AuthEntry{
			{ID: "codex", Provider: ProviderCodex, Purpose: testPurpose("openai-upstream")},
		},
		Protocols: []ProviderProtocol{ProtocolOpenAIResponses},
	}
	broker := &sequenceBroker{leases: []OAuthBearerLease{
		validLease("member-a", map[string]string{"Chatgpt-Account-Id": "account-a"}),
		validLease("member-b", map[string]string{"Chatgpt-Account-Id": "account-b"}),
		validLease("member-c", map[string]string{"Chatgpt-Account-Id": "account-c"}),
	}}
	upstream := &protocolFixtureRoundTripper{statuses: []int{
		http.StatusTooManyRequests,
		http.StatusForbidden,
		http.StatusOK,
	}}
	gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
	if err != nil {
		t.Fatalf("NewGateway() error = %v", err)
	}
	cancel, runResult := runGateway(t, gateway)
	defer stopGateway(t, cancel, runResult)
	_ = awaitReadiness(t, gateway)

	wantStatuses := []int{http.StatusTooManyRequests, http.StatusForbidden, http.StatusOK}
	for i, want := range wantStatuses {
		response := postJSON(t, cfg, "/v1/responses", `{"model":"gpt-5.5","input":"hello"}`)
		if response.StatusCode != want {
			t.Fatalf("request %d downstream status = %d, want %d; body=%s", i+1, response.StatusCode, want, readResponse(t, response))
		}
		_ = response.Body.Close()
		if got := len(upstream.requests()); got != i+1 {
			t.Fatalf("after request %d upstream effects = %d, want exactly %d", i+1, got, i+1)
		}
	}

	requests := upstream.requests()
	for i, want := range []string{"account-a", "account-b", "account-c"} {
		if got := requests[i].Header.Get("Chatgpt-Account-Id"); got != want {
			t.Fatalf("request %d account identity = %q, want %q", i+1, got, want)
		}
	}
	assertNoRuntimeStateFiles(t, cfg.RuntimeDir)
}

func TestPinnedSDKComposesOneLeafCurrentnessRetryWithoutManagerOrBootstrapReplay(t *testing.T) {
	testCases := []struct {
		name               string
		body               string
		upstreamStatuses   []int
		upstreamBodyErrors []error
		wantStatus         int
		wantEffects        int
		wantReports        int
	}{
		{
			name:             "current material change succeeds on one leaf retry",
			body:             `{"model":"gpt-5.5","input":"hello"}`,
			upstreamStatuses: []int{http.StatusUnauthorized, http.StatusOK, http.StatusOK},
			wantStatus:       http.StatusOK,
			wantEffects:      2,
			wantReports:      1,
		},
		{
			name:             "repeated unauthorized response stops after two total effects",
			body:             `{"model":"gpt-5.5","input":"hello"}`,
			upstreamStatuses: []int{http.StatusUnauthorized, http.StatusUnauthorized, http.StatusOK},
			wantStatus:       http.StatusUnauthorized,
			wantEffects:      2,
			wantReports:      2,
		},
		{
			name:               "pre-payload streaming failure has no hidden bootstrap replay",
			body:               `{"model":"gpt-5.5","stream":true,"input":"hello"}`,
			upstreamStatuses:   []int{http.StatusOK, http.StatusOK},
			upstreamBodyErrors: []error{io.ErrUnexpectedEOF, nil},
			wantStatus:         http.StatusRequestTimeout,
			wantEffects:        1,
			wantReports:        0,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			port := reserveLoopbackPort(t)
			cfg := Config{
				Host:             "127.0.0.1",
				Port:             port,
				DownstreamBearer: "downstream-session-bearer",
				RuntimeDir:       t.TempDir(),
				AuthEntries: []AuthEntry{
					{ID: "codex", Provider: ProviderCodex, Purpose: testPurpose("openai-upstream")},
				},
				Protocols: []ProviderProtocol{ProtocolOpenAIResponses},
			}
			leases := []OAuthBearerLease{
				validLease("member-a", map[string]string{"Chatgpt-Account-Id": "account-header-a"}),
				validLease("member-b", map[string]string{"Chatgpt-Account-Id": "account-header-b"}),
				validLease("member-c-must-not-be-used", map[string]string{"Chatgpt-Account-Id": "account-header-c"}),
			}
			leases[0].CredentialContext.Account.AccountID = "account-a"
			leases[0].CredentialContext.CredentialRevision = "csr_0123456789ABCDEFGHJKMNPQRS"
			leases[1].CredentialContext.Account.AccountID = "account-b"
			leases[1].CredentialContext.CredentialRevision = "csr_1123456789ABCDEFGHJKMNPQRS"
			leases[2].CredentialContext.Account.AccountID = "account-c"
			leases[2].CredentialContext.CredentialRevision = "csr_2123456789ABCDEFGHJKMNPQRS"

			broker := &sequenceBroker{
				leases: leases,
				authOutcomes: []RequestAuthFailureOutcome{
					{Status: FailureStatusCurrentChanged},
					{Status: FailureStatusCurrentChanged},
					{Status: FailureStatusCurrentChanged},
				},
			}
			upstream := &protocolFixtureRoundTripper{
				statuses:   tc.upstreamStatuses,
				bodyErrors: tc.upstreamBodyErrors,
			}
			gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
			if err != nil {
				t.Fatalf("NewGateway() error = %v", err)
			}
			cancel, runResult := runGateway(t, gateway)
			defer stopGateway(t, cancel, runResult)
			_ = awaitReadiness(t, gateway)

			response := postJSON(t, cfg, "/v1/responses", tc.body)
			responseBody := readResponse(t, response)
			_ = response.Body.Close()
			if response.StatusCode != tc.wantStatus {
				t.Fatalf(
					"downstream status = %d, want %d; body=%s",
					response.StatusCode,
					tc.wantStatus,
					responseBody,
				)
			}

			purposes := broker.purposes()
			if len(purposes) != tc.wantEffects {
				t.Fatalf("request-auth lookups = %d, want exactly %d", len(purposes), tc.wantEffects)
			}
			wantPurpose := testPurpose("openai-upstream")
			for i, purpose := range purposes {
				if purpose != wantPurpose {
					t.Fatalf("request-auth lookup %d purpose = %#v, want %#v", i+1, purpose, wantPurpose)
				}
			}

			broker.mu.Lock()
			authFailures := append([]ConnectedAccountAuthFailureRequest(nil), broker.authFailures...)
			broker.mu.Unlock()
			if len(authFailures) != tc.wantReports {
				t.Fatalf("auth-failure reports = %d, want exactly %d", len(authFailures), tc.wantReports)
			}
			for i, failure := range authFailures {
				if failure.CredentialContext.Account.AccountID != leases[i].CredentialContext.Account.AccountID ||
					failure.CredentialContext.CredentialRevision != leases[i].CredentialContext.CredentialRevision {
					t.Fatalf(
						"auth-failure report %d credential context = %#v, want account %q revision %q",
						i+1,
						failure.CredentialContext,
						leases[i].CredentialContext.Account.AccountID,
						leases[i].CredentialContext.CredentialRevision,
					)
				}
				evidence := failure.NormalizedFailure.Evidence
				if failure.NormalizedFailure.Class != "authentication" ||
					evidence.HTTPStatus == nil ||
					*evidence.HTTPStatus != http.StatusUnauthorized {
					t.Fatalf("auth-failure report %d = %#v, want normalized HTTP 401 authentication", i+1, failure)
				}
			}

			requests := upstream.requests()
			if len(requests) != tc.wantEffects {
				t.Fatalf("upstream effects = %d, want exactly %d", len(requests), tc.wantEffects)
			}
			wantAuthorization := []string{"Bearer member-a", "Bearer member-b"}
			wantAccountHeader := []string{"account-header-a", "account-header-b"}
			for i, request := range requests {
				if got := request.Header.Get("Authorization"); got != wantAuthorization[i] {
					t.Fatalf("upstream request %d Authorization = %q, want %q", i+1, got, wantAuthorization[i])
				}
				if got := request.Header.Get("Chatgpt-Account-Id"); got != wantAccountHeader[i] {
					t.Fatalf("upstream request %d account header = %q, want %q", i+1, got, wantAccountHeader[i])
				}
			}
			assertNoRuntimeStateFiles(t, cfg.RuntimeDir)
		})
	}
}

func TestPinnedSDKManagedRetryConfigurationRemainsInert(t *testing.T) {
	cfg := managedSDKConfig(Config{})
	if cfg.RequestRetry != 0 {
		t.Fatalf("managed RequestRetry = %d, want 0", cfg.RequestRetry)
	}
	if cfg.Streaming.BootstrapRetries != 0 {
		t.Fatalf("managed streaming BootstrapRetries = %d, want 0", cfg.Streaming.BootstrapRetries)
	}
	if got := sdkhandlers.StreamingBootstrapRetries(&cfg.SDKConfig); got != 0 {
		t.Fatalf("resolved managed streaming bootstrap retries = %d, want 0", got)
	}
	if got := sdkhandlers.StreamingBootstrapRetries(nil); got != 0 {
		t.Fatalf("pinned SDK default streaming bootstrap retries = %d, want 0", got)
	}
}

func TestPinnedSDKKeepsDownstreamBearerSeparateFromBrokerCapabilityAndOtherSessions(t *testing.T) {
	port := reserveLoopbackPort(t)
	cfg := Config{
		Host:             "127.0.0.1",
		Port:             port,
		DownstreamBearer: "downstream-session-a",
		RuntimeDir:       t.TempDir(),
		AuthEntries: []AuthEntry{
			{ID: "codex", Provider: ProviderCodex, Purpose: testPurpose("openai-upstream")},
		},
		Protocols: []ProviderProtocol{ProtocolOpenAIResponses},
	}
	broker := &sequenceBroker{leases: []OAuthBearerLease{
		validLease("current-upstream", nil),
	}}
	upstream := &protocolFixtureRoundTripper{}
	gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
	if err != nil {
		t.Fatalf("NewGateway() error = %v", err)
	}
	cancel, runResult := runGateway(t, gateway)
	defer stopGateway(t, cancel, runResult)
	_ = awaitReadiness(t, gateway)

	for _, unauthorized := range []string{
		"wrapper-to-daemon-capability",
		"downstream-session-b",
	} {
		response := postJSONWithBearer(
			t,
			cfg,
			"/v1/responses",
			`{"model":"gpt-5.5","input":"must stay session scoped"}`,
			unauthorized,
		)
		if response.StatusCode < http.StatusBadRequest {
			t.Fatalf("unauthorized bearer %q status = %d", unauthorized, response.StatusCode)
		}
		_ = response.Body.Close()
	}
	if got := len(broker.purposes()); got != 0 {
		t.Fatalf("unauthorized downstream requests reached broker %d times", got)
	}
	if got := len(upstream.requests()); got != 0 {
		t.Fatalf("unauthorized downstream requests caused %d upstream effects", got)
	}

	response := postJSON(
		t,
		cfg,
		"/v1/responses",
		`{"model":"gpt-5.5","input":"authorized session request"}`,
	)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("authorized downstream status = %d, body=%s", response.StatusCode, readResponse(t, response))
	}
	_ = response.Body.Close()
	if got := len(broker.purposes()); got != 1 {
		t.Fatalf("authorized downstream request broker lookups = %d, want 1", got)
	}
	if got := len(upstream.requests()); got != 1 {
		t.Fatalf("authorized downstream request upstream effects = %d, want 1", got)
	}
}

func TestPinnedSDKPreservesStreamingToolsAndDownstreamWebsocketOverFinalTransport(t *testing.T) {
	port := reserveLoopbackPort(t)
	cfg := Config{
		Host:             "127.0.0.1",
		Port:             port,
		DownstreamBearer: "downstream-session-bearer",
		RuntimeDir:       t.TempDir(),
		AuthEntries: []AuthEntry{
			{ID: "codex", Provider: ProviderCodex, Purpose: testPurpose("openai-upstream")},
		},
		Protocols: []ProviderProtocol{ProtocolOpenAIResponses},
	}
	broker := &sequenceBroker{leases: []OAuthBearerLease{
		validLease("stream-member", map[string]string{"Chatgpt-Account-Id": "stream-account"}),
		validLease("websocket-member", map[string]string{"Chatgpt-Account-Id": "websocket-account"}),
	}}
	upstream := &protocolFixtureRoundTripper{}
	gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
	if err != nil {
		t.Fatalf("NewGateway() error = %v", err)
	}
	cancel, runResult := runGateway(t, gateway)
	defer stopGateway(t, cancel, runResult)
	_ = awaitReadiness(t, gateway)

	streamResponse := postJSON(t, cfg, "/v1/responses", `{
		"model":"gpt-5.5",
		"stream":true,
		"input":"use the tool",
		"tools":[{
			"type":"function",
			"name":"fixture_tool",
			"description":"fixture",
			"parameters":{"type":"object","properties":{}}
		}]
	}`)
	if streamResponse.StatusCode != http.StatusOK {
		t.Fatalf("stream status = %d, body=%s", streamResponse.StatusCode, readResponse(t, streamResponse))
	}
	streamBody := readResponse(t, streamResponse)
	_ = streamResponse.Body.Close()
	if !strings.Contains(streamBody, `"type":"response.completed"`) {
		t.Fatalf("stream omitted terminal event: %s", streamBody)
	}

	headers := http.Header{"Authorization": {"Bearer " + cfg.DownstreamBearer}}
	connection, response, err := websocket.DefaultDialer.Dial(
		fmt.Sprintf("ws://%s:%d/v1/responses", cfg.Host, cfg.Port),
		headers,
	)
	if err != nil {
		if response != nil {
			t.Fatalf("dial downstream websocket: %v (status %d)", err, response.StatusCode)
		}
		t.Fatalf("dial downstream websocket: %v", err)
	}
	defer connection.Close()
	if err := connection.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := connection.WriteMessage(websocket.TextMessage, []byte(
		`{"type":"response.create","model":"gpt-5.5","input":[{"type":"message","role":"user","content":"hello"}]}`,
	)); err != nil {
		t.Fatalf("write downstream websocket: %v", err)
	}
	_, websocketPayload, err := connection.ReadMessage()
	if err != nil {
		t.Fatalf("read downstream websocket: %v", err)
	}
	if !strings.Contains(string(websocketPayload), `"type":"response.completed"`) {
		t.Fatalf("downstream websocket terminal payload = %s", websocketPayload)
	}

	requests := upstream.requests()
	if len(requests) != 2 {
		t.Fatalf("upstream requests = %d, want streaming HTTP and websocket-over-SSE", len(requests))
	}
	firstBody, err := io.ReadAll(requests[0].Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(firstBody), `"name":"fixture_tool"`) {
		t.Fatalf("executor-shaped upstream request omitted tool: %s", firstBody)
	}
	if got := requests[0].Header.Get("Authorization"); got != "Bearer stream-member" {
		t.Fatalf("streaming Authorization = %q", got)
	}
	if got := requests[1].Header.Get("Authorization"); got != "Bearer websocket-member" {
		t.Fatalf("websocket-over-SSE Authorization = %q", got)
	}
}

func TestPinnedSDKPropagatesDownstreamCancellationToFinalTransport(t *testing.T) {
	port := reserveLoopbackPort(t)
	cfg := Config{
		Host:             "127.0.0.1",
		Port:             port,
		DownstreamBearer: "downstream-session-bearer",
		RuntimeDir:       t.TempDir(),
		AuthEntries: []AuthEntry{
			{ID: "codex", Provider: ProviderCodex, Purpose: testPurpose("openai-upstream")},
		},
		Protocols: []ProviderProtocol{ProtocolOpenAIResponses},
	}
	broker := &sequenceBroker{leases: []OAuthBearerLease{validLease("cancel-member", nil)}}
	upstream := &cancellationRoundTripper{
		started:  make(chan struct{}),
		canceled: make(chan struct{}),
	}
	gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
	if err != nil {
		t.Fatalf("NewGateway() error = %v", err)
	}
	cancelGateway, runResult := runGateway(t, gateway)
	defer stopGateway(t, cancelGateway, runResult)
	_ = awaitReadiness(t, gateway)

	requestContext, cancelRequest := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(
		requestContext,
		http.MethodPost,
		fmt.Sprintf("http://%s:%d/v1/responses", cfg.Host, cfg.Port),
		strings.NewReader(`{"model":"gpt-5.5","input":"cancel me"}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+cfg.DownstreamBearer)
	clientResult := make(chan error, 1)
	go func() {
		response, errDo := http.DefaultClient.Do(request)
		if response != nil {
			_ = response.Body.Close()
		}
		clientResult <- errDo
	}()
	select {
	case <-upstream.started:
	case <-time.After(5 * time.Second):
		t.Fatal("final transport did not start")
	}
	cancelRequest()
	select {
	case <-upstream.canceled:
	case <-time.After(5 * time.Second):
		t.Fatal("downstream cancellation did not reach final transport")
	}
	select {
	case err := <-clientResult:
		if err == nil {
			t.Fatal("canceled downstream request returned no error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("canceled downstream request did not finish")
	}
}

func validLease(token string, headers map[string]string) OAuthBearerLease {
	return OAuthBearerLease{
		AccessToken:     token,
		RequiredHeaders: headers,
		CredentialContext: RequestAuthCredentialContext{
			Account: QualifiedAccountRef{
				Service:   ContributionIdentity{PluginID: "happier.connected-service.openai", LocalID: "account"},
				AccountID: "account-fixture",
			},
			CredentialRevision: "csr_0123456789ABCDEFGHJKMNPQRS",
		},
	}
}

func reserveLoopbackPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve loopback port: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatalf("release loopback port: %v", err)
	}
	return port
}

func runGateway(t *testing.T, gateway *Gateway) (context.CancelFunc, <-chan error) {
	t.Helper()
	t.Cleanup(func() {
		coreauth.SetQuotaCooldownDisabled(false)
		coreauth.SetTransientErrorCooldownSeconds(0)
	})
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- gateway.Run(ctx) }()
	return cancel, result
}

func stopGateway(t *testing.T, cancel context.CancelFunc, result <-chan error) {
	t.Helper()
	cancel()
	select {
	case err := <-result:
		if err != nil && !errorsIsContextCancellation(err) {
			t.Fatalf("gateway Run() after cancellation = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("gateway did not stop after cancellation")
	}
}

func errorsIsContextCancellation(err error) bool {
	return err == context.Canceled || strings.Contains(err.Error(), context.Canceled.Error())
}

func awaitReadiness(t *testing.T, gateway *Gateway) Readiness {
	t.Helper()
	select {
	case readiness := <-gateway.Ready():
		return readiness
	case <-time.After(5 * time.Second):
		t.Fatal("gateway readiness timed out")
		return Readiness{}
	}
}

func postJSON(t *testing.T, cfg Config, path, body string) *http.Response {
	return postJSONWithBearer(t, cfg, path, body, cfg.DownstreamBearer)
}

func postJSONWithBearer(
	t *testing.T,
	cfg Config,
	path string,
	body string,
	bearer string,
) *http.Response {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://%s:%d%s", cfg.Host, cfg.Port, path), strings.NewReader(body))
	if err != nil {
		t.Fatalf("create downstream request: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+bearer)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("downstream request: %v", err)
	}
	return response
}

func readResponse(t *testing.T, response *http.Response) string {
	t.Helper()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	return string(body)
}

func assertStrictSurface(t *testing.T, cfg Config, method, path string) {
	t.Helper()
	request, err := http.NewRequest(method, fmt.Sprintf("http://%s:%d%s", cfg.Host, cfg.Port, path), nil)
	if err != nil {
		t.Fatalf("create strict-surface request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+cfg.DownstreamBearer)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("strict-surface request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("%s %s status = %d, want 404", method, path, response.StatusCode)
	}
}

func catalogContains(catalog []CatalogModel, provider Provider, id string) bool {
	for _, model := range catalog {
		if model.Provider == provider && model.ID == id {
			return true
		}
	}
	return false
}

func getStrictOpenAIModelCatalog(t *testing.T, cfg Config) []map[string]json.RawMessage {
	t.Helper()
	request, err := http.NewRequest(
		http.MethodGet,
		fmt.Sprintf("http://%s:%d/v1/models", cfg.Host, cfg.Port),
		nil,
	)
	if err != nil {
		t.Fatalf("create model catalog request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+cfg.DownstreamBearer)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("model catalog request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("model catalog status = %d, want 200", response.StatusCode)
	}

	var envelope map[string]json.RawMessage
	decoder := json.NewDecoder(response.Body)
	if errDecode := decoder.Decode(&envelope); errDecode != nil {
		t.Fatalf("decode model catalog: %v", errDecode)
	}
	if len(envelope) != 2 || envelope["object"] == nil || envelope["data"] == nil {
		t.Fatalf("model catalog envelope keys = %#v, want exact object/data", envelope)
	}
	var object string
	if errDecode := json.Unmarshal(envelope["object"], &object); errDecode != nil || object != "list" {
		t.Fatalf("model catalog object = %q, error = %v", object, errDecode)
	}
	var rows []map[string]json.RawMessage
	if errDecode := json.Unmarshal(envelope["data"], &rows); errDecode != nil {
		t.Fatalf("decode model catalog rows: %v", errDecode)
	}
	for i, row := range rows {
		for key := range row {
			switch key {
			case "id", "object", "created", "owned_by":
			default:
				t.Fatalf("model catalog row %d has unexpected key %q", i, key)
			}
		}
		if len(row) < 3 || row["id"] == nil || row["object"] == nil || row["owned_by"] == nil {
			t.Fatalf("model catalog row %d keys = %#v, want id/object/owned_by and optional created", i, row)
		}
		var id, rowObject, ownedBy string
		if errDecode := json.Unmarshal(row["id"], &id); errDecode != nil || id == "" {
			t.Fatalf("model catalog row %d id = %q, error = %v", i, id, errDecode)
		}
		if errDecode := json.Unmarshal(row["object"], &rowObject); errDecode != nil || rowObject != "model" {
			t.Fatalf("model catalog row %d object = %q, error = %v", i, rowObject, errDecode)
		}
		if errDecode := json.Unmarshal(row["owned_by"], &ownedBy); errDecode != nil {
			t.Fatalf("model catalog row %d owned_by error = %v", i, errDecode)
		}
		if created := row["created"]; created != nil {
			var createdAt int64
			if errDecode := json.Unmarshal(created, &createdAt); errDecode != nil || createdAt <= 0 {
				t.Fatalf("model catalog row %d created = %d, error = %v", i, createdAt, errDecode)
			}
		}
	}
	return rows
}

func getManagedHealthIdentity(t *testing.T, cfg Config) ManagedHealthIdentity {
	t.Helper()
	response, err := http.Get(fmt.Sprintf(
		"http://%s:%d/healthz",
		cfg.Host,
		cfg.Port,
	))
	if err != nil {
		t.Fatalf("managed health request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("managed health status = %d, want 200", response.StatusCode)
	}
	if got := response.Header.Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("managed health content type = %q", got)
	}
	decoder := json.NewDecoder(response.Body)
	decoder.DisallowUnknownFields()
	var identity ManagedHealthIdentity
	if err := decoder.Decode(&identity); err != nil {
		t.Fatalf("decode managed health identity: %v", err)
	}
	return identity
}

func assertCatalogMatchesRegisteredModels(
	t *testing.T,
	httpCatalog []map[string]json.RawMessage,
	registeredCatalog []CatalogModel,
) {
	t.Helper()
	expected := make(map[string]struct{}, len(registeredCatalog))
	for _, model := range registeredCatalog {
		expected[model.ID] = struct{}{}
	}
	seen := make(map[string]struct{}, len(httpCatalog))
	for i, row := range httpCatalog {
		var id string
		if err := json.Unmarshal(row["id"], &id); err != nil {
			t.Fatalf("decode HTTP catalog row %d id: %v", i, err)
		}
		if _, duplicate := seen[id]; duplicate {
			t.Fatalf("HTTP catalog duplicated model id %q", id)
		}
		seen[id] = struct{}{}
	}
	if len(seen) != len(expected) {
		t.Fatalf("HTTP catalog model count = %d, registered unique model count = %d", len(seen), len(expected))
	}
	for id := range expected {
		if _, exists := seen[id]; !exists {
			t.Fatalf("HTTP catalog omitted registered model %q", id)
		}
	}
}

func assertNoRuntimeStateFiles(t *testing.T, root string) {
	t.Helper()
	var files []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk runtime directory: %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("managed runtime persisted files: %#v", files)
	}
}

type protocolFixtureRoundTripper struct {
	mu         sync.Mutex
	seen       []*http.Request
	statuses   []int
	bodyErrors []error
}

type cancellationRoundTripper struct {
	started  chan struct{}
	canceled chan struct{}
}

func (t *cancellationRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	close(t.started)
	<-request.Context().Done()
	close(t.canceled)
	return nil, request.Context().Err()
}

func (f *protocolFixtureRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	body, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, err
	}
	cloned := request.Clone(request.Context())
	cloned.Header = request.Header.Clone()
	cloned.Body = io.NopCloser(bytes.NewReader(body))

	f.mu.Lock()
	f.seen = append(f.seen, cloned)
	index := len(f.seen) - 1
	status := http.StatusOK
	if index < len(f.statuses) {
		status = f.statuses[index]
	}
	var bodyError error
	if index < len(f.bodyErrors) {
		bodyError = f.bodyErrors[index]
	}
	f.mu.Unlock()

	if status != http.StatusOK {
		return &http.Response{
			StatusCode: status,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body: io.NopCloser(strings.NewReader(fmt.Sprintf(
				`{"error":{"message":"fixture failure","type":"fixture","code":"fixture_%d"}}`,
				status,
			))),
			Request: request,
		}, nil
	}
	if strings.Contains(request.URL.Host, "anthropic") {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body: io.NopCloser(strings.NewReader(
				`{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}`,
			)),
			Request: request,
		}, nil
	}
	if bodyError != nil {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"text/event-stream"}},
			Body:       io.NopCloser(iotest.ErrReader(bodyError)),
			Request:    request,
		}, nil
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"text/event-stream"}},
		Body: io.NopCloser(strings.NewReader(
			"data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5.5\",\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
		)),
		Request: request,
	}, nil
}

func (f *protocolFixtureRoundTripper) requests() []*http.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*http.Request(nil), f.seen...)
}
