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
			testAuthEntry("codex", ProviderCodex, "openai-upstream"),
			testAuthEntry("claude", ProviderClaude, "anthropic-upstream"),
		},
		Protocols: []ProviderProtocol{
			ProtocolOpenAIChat,
			ProtocolOpenAIResponses,
			ProtocolAnthropic,
		},
		ModelListEnabled: true,
	}
	broker := &sequenceBroker{leases: []OAuthBearerLease{
		validLease("codex-current", map[string]string{"Chatgpt-Account-Id": "account-current"}),
		validLease("claude-current", nil),
		validLease("codex-chat-current", map[string]string{"Chatgpt-Account-Id": "account-chat-current"}),
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

	healthIdentity := awaitManagedHealthIdentity(t, cfg)
	if healthIdentity.ContractVersion != WrapperContractVersion || healthIdentity.SDKVersion != PinnedSDKVersion {
		t.Fatalf("health identity versions = %#v", healthIdentity)
	}
	if len(healthIdentity.Protocols) != 3 ||
		healthIdentity.Protocols[0] != ProtocolOpenAIChat ||
		healthIdentity.Protocols[1] != ProtocolOpenAIResponses ||
		healthIdentity.Protocols[2] != ProtocolAnthropic {
		t.Fatalf("health identity protocols = %#v", healthIdentity.Protocols)
	}
	if healthIdentity.WrapperBuildVersion != testRuntimeIdentity().WrapperBuildVersion ||
		!healthIdentity.ModelListEnabled ||
		len(healthIdentity.Protocols) != 3 ||
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

	// OpenAI Chat is a distinct downstream protocol served by the same Codex executor:
	// the wrapper accepts a chat-completions request, shapes it onto the Codex Responses
	// upstream, and answers in chat-completions form. Without this leg the harness proves
	// the contract only for the Responses and Anthropic surfaces.
	chatResponse := postJSON(t, cfg, "/v1/chat/completions", `{"model":"gpt-5.5","messages":[{"role":"user","content":"hello"}]}`)
	if chatResponse.StatusCode != http.StatusOK {
		t.Fatalf("OpenAI Chat downstream status = %d, body=%s", chatResponse.StatusCode, readResponse(t, chatResponse))
	}
	chatBody := readResponse(t, chatResponse)
	if !strings.Contains(chatBody, `"object":"chat.completion"`) || !strings.Contains(chatBody, `"choices"`) {
		t.Fatalf("OpenAI Chat downstream body did not keep the chat-completions protocol: %s", chatBody)
	}

	requests := upstream.requests()
	if len(requests) != 3 {
		t.Fatalf("upstream requests = %d, want 3", len(requests))
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
	if got := requests[2].URL.String(); got != "https://chatgpt.com/backend-api/codex/responses" {
		t.Fatalf("OpenAI Chat final upstream URL = %q", got)
	}
	if got := requests[2].Header.Get("Authorization"); got != "Bearer codex-chat-current" {
		t.Fatalf("OpenAI Chat final Authorization = %q", got)
	}
	if got := requests[2].Header.Get("Chatgpt-Account-Id"); got != "account-chat-current" {
		t.Fatalf("OpenAI Chat final account header = %q", got)
	}
	if strings.Contains(requests[2].Header.Get("Authorization"), "stale") {
		t.Fatal("OpenAI Chat registration-time token survived final transport")
	}

	assertStrictSurface(t, cfg, http.MethodGet, "/v0/management/config")
	assertStrictSurface(t, cfg, http.MethodGet, "/management.html")
	assertStrictSurface(t, cfg, http.MethodGet, "/codex/callback")
	assertStrictSurface(t, cfg, http.MethodGet, "/")

	assertNoRuntimeStateFiles(t, runtimeDir)
}

func TestPinnedSDKSparseOpenAIBindingExcludesUnboundClaudeServingAndCatalog(t *testing.T) {
	port := reserveLoopbackPort(t)
	cfg := Config{
		Host:             "127.0.0.1",
		Port:             port,
		DownstreamBearer: "downstream-session-bearer",
		RuntimeDir:       t.TempDir(),
		AuthEntries: []AuthEntry{
			testAuthEntry("codex", ProviderCodex, "openai-upstream"),
		},
		Protocols: []ProviderProtocol{
			ProtocolOpenAIChat,
			ProtocolOpenAIResponses,
		},
		ModelListEnabled: true,
	}
	broker := &sequenceBroker{}
	upstream := &protocolFixtureRoundTripper{}
	gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
	if err != nil {
		t.Fatalf("NewGateway() error = %v", err)
	}
	cancel, runResult := runGateway(t, gateway)
	defer stopGateway(t, cancel, runResult)

	healthIdentity := awaitManagedHealthIdentity(t, cfg)
	if got := healthIdentity.Protocols; len(got) != 2 ||
		got[0] != ProtocolOpenAIChat || got[1] != ProtocolOpenAIResponses {
		t.Fatalf("health identity protocols = %#v", got)
	}
	if got := healthIdentity.Purposes; len(got) != 1 || got[0] != testPurpose("openai-upstream") {
		t.Fatalf("health identity purposes = %#v", got)
	}
	if len(healthIdentity.Protocols) != 2 || len(healthIdentity.Purposes) != 1 ||
		healthIdentity.Purposes[0] != testPurpose("openai-upstream") {
		t.Fatalf("sparse health identity = %#v", healthIdentity)
	}
	for _, model := range gateway.Catalog() {
		if model.Provider == ProviderClaude {
			t.Fatalf("sparse catalog advertised unbound Claude model %#v", model)
		}
	}

	response := postJSON(t, cfg, "/v1/messages", `{"model":"claude-sonnet-4-6","max_tokens":16,"messages":[{"role":"user","content":"hello"}]}`)
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("unbound Claude downstream status = %d, want 404", response.StatusCode)
	}
	if got := len(broker.purposes()); got != 0 {
		t.Fatalf("unbound Claude route performed %d request-auth lookups", got)
	}
	if got := len(upstream.requests()); got != 0 {
		t.Fatalf("unbound Claude route performed %d upstream effects", got)
	}
}

func TestPinnedSDKClaudeExecutorKeepsRequestShapingOutsideRequestTimeCredentialOwnership(t *testing.T) {
	testCases := []struct {
		name              string
		registrationToken string
		wantToolName      string
	}{
		{
			name:         "OAuth sentinel",
			wantToolName: "Bash",
		},
		{
			name:              "neutral bearer sentinel",
			registrationToken: "happier-neutral-registration-sentinel",
			wantToolName:      "bash",
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			port := reserveLoopbackPort(t)
			cfg := Config{
				Host:             "127.0.0.1",
				Port:             port,
				DownstreamBearer: "downstream-session-bearer",
				RuntimeDir:       t.TempDir(),
				AuthEntries: []AuthEntry{
					testAuthEntry("claude", ProviderClaude, "anthropic-upstream"),
				},
				Protocols: []ProviderProtocol{ProtocolAnthropic},
			}
			broker := &sequenceBroker{leases: []OAuthBearerLease{validLease("claude-current", nil)}}
			upstream := &protocolFixtureRoundTripper{}
			var mutateAuth func(*coreauth.Auth)
			if testCase.registrationToken != "" {
				mutateAuth = func(auth *coreauth.Auth) {
					auth.Metadata["access_token"] = testCase.registrationToken
				}
			}
			gateway, err := newGatewayForConformance(
				cfg,
				testRuntimeIdentity(),
				broker,
				upstream,
				mutateAuth,
			)
			if err != nil {
				t.Fatalf("newGatewayForConformance() error = %v", err)
			}
			cancel, runResult := runGateway(t, gateway)
			defer stopGateway(t, cancel, runResult)
			_ = awaitManagedHealthIdentity(t, cfg)

			response := postJSON(t, cfg, "/v1/messages", `{
				"model":"claude-sonnet-4-6",
				"max_tokens":16,
				"messages":[{"role":"user","content":"hello"}],
				"tools":[{
					"name":"bash",
					"description":"fixture",
					"input_schema":{"type":"object","properties":{}}
				}]
			}`)
			if response.StatusCode != http.StatusOK {
				t.Fatalf("Claude downstream status = %d, body=%s", response.StatusCode, readResponse(t, response))
			}
			_ = response.Body.Close()

			requests := upstream.requests()
			if len(requests) != 1 {
				t.Fatalf("upstream requests = %d, want 1", len(requests))
			}
			var upstreamBody struct {
				Tools []struct {
					Name         string         `json:"name"`
					CacheControl map[string]any `json:"cache_control"`
				} `json:"tools"`
			}
			if errDecode := json.NewDecoder(requests[0].Body).Decode(&upstreamBody); errDecode != nil {
				t.Fatalf("decode Claude upstream body: %v", errDecode)
			}
			if len(upstreamBody.Tools) != 1 {
				t.Fatalf("Claude upstream tools = %#v, want one caller tool", upstreamBody.Tools)
			}
			if got := upstreamBody.Tools[0].Name; got != testCase.wantToolName {
				t.Fatalf("Claude upstream tool name = %q, want %q", got, testCase.wantToolName)
			}
			if got := upstreamBody.Tools[0].CacheControl["type"]; got != "ephemeral" {
				t.Fatalf("Claude upstream tool cache_control type = %#v, want pinned executor injection", got)
			}
			if got := requests[0].Header.Get("Authorization"); got != "Bearer claude-current" {
				t.Fatalf("Claude final Authorization = %q", got)
			}
			if got := requests[0].Header.Get("X-Claude-Code-Session-Id"); got != "" {
				t.Fatalf("Claude credential-derived session identity survived final transport = %q", got)
			}
			if got := requests[0].Header.Get("X-App"); got != "cli" {
				t.Fatalf("Claude upstream X-App = %q, want pinned executor identity header", got)
			}
			if got := requests[0].Header.Get("Anthropic-Beta"); !strings.Contains(got, "claude-code-20250219") {
				t.Fatalf("Claude upstream Anthropic-Beta = %q, want pinned executor Claude Code identity beta", got)
			}
			assertNoRuntimeStateFiles(t, cfg.RuntimeDir)
		})
	}
}

func TestPinnedSDKClaudeStreamingAndCountTokensUseFinalLeaseAfterExecutorShaping(t *testing.T) {
	testCases := []struct {
		name                   string
		path                   string
		body                   string
		leaseToken             string
		leaseAppHeader         string
		wantUpstreamPath       string
		wantUpstreamAccept     string
		wantStream             bool
		wantDownstreamFragment string
	}{
		{
			name: "streaming messages",
			path: "/v1/messages",
			body: `{
				"model":"claude-sonnet-4-6",
				"max_tokens":16,
				"stream":true,
				"messages":[{"role":"user","content":"hello"}],
				"tools":[{
					"name":"bash",
					"description":"fixture",
					"input_schema":{"type":"object","properties":{}}
				}]
			}`,
			leaseToken:             "claude-stream-current",
			leaseAppHeader:         "current-stream-app",
			wantUpstreamPath:       "/v1/messages",
			wantUpstreamAccept:     "text/event-stream",
			wantStream:             true,
			wantDownstreamFragment: `"type":"message_stop"`,
		},
		{
			name: "count tokens",
			path: "/v1/messages/count_tokens",
			body: `{
				"model":"claude-sonnet-4-6",
				"messages":[{"role":"user","content":"hello"}],
				"tools":[{
					"name":"bash",
					"description":"fixture",
					"input_schema":{"type":"object","properties":{}}
				}]
			}`,
			leaseToken:             "claude-count-current",
			leaseAppHeader:         "current-count-app",
			wantUpstreamPath:       "/v1/messages/count_tokens",
			wantUpstreamAccept:     "application/json",
			wantDownstreamFragment: `"input_tokens":7`,
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			cfg := Config{
				Host:             "127.0.0.1",
				Port:             reserveLoopbackPort(t),
				DownstreamBearer: "downstream-session-bearer",
				RuntimeDir:       t.TempDir(),
				AuthEntries: []AuthEntry{
					testAuthEntry("claude", ProviderClaude, "anthropic-upstream"),
				},
				Protocols: []ProviderProtocol{ProtocolAnthropic},
			}
			broker := &sequenceBroker{leases: []OAuthBearerLease{validLease(
				testCase.leaseToken,
				map[string]string{"X-App": testCase.leaseAppHeader},
			)}}
			upstream := &protocolFixtureRoundTripper{}
			gateway, err := newGatewayForConformance(
				cfg,
				testRuntimeIdentity(),
				broker,
				upstream,
				func(auth *coreauth.Auth) {
					auth.Metadata["access_token"] = "sk-ant-oat01-stale-registration-token"
				},
			)
			if err != nil {
				t.Fatalf("newGatewayForConformance() error = %v", err)
			}
			cancel, runResult := runGateway(t, gateway)
			defer stopGateway(t, cancel, runResult)
			_ = awaitManagedHealthIdentity(t, cfg)

			response := postJSON(t, cfg, testCase.path, testCase.body)
			responseBody := readResponse(t, response)
			_ = response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("downstream status = %d, body=%s", response.StatusCode, responseBody)
			}

			purposes := broker.purposes()
			if len(purposes) != 1 || purposes[0] != testPurpose("anthropic-upstream") {
				t.Fatalf("request-auth lookups = %#v, want exactly one anthropic-upstream lookup", purposes)
			}
			requests := upstream.requests()
			if len(requests) != 1 {
				t.Fatalf("upstream effects = %d, want exactly 1", len(requests))
			}
			request := requests[0]
			if request.URL.Path != testCase.wantUpstreamPath || request.URL.RawQuery != "beta=true" {
				t.Fatalf("upstream URL = %q, want path %q with beta=true", request.URL.String(), testCase.wantUpstreamPath)
			}
			if got := request.Header.Get("Authorization"); got != "Bearer "+testCase.leaseToken {
				t.Fatalf("final Authorization = %q, want current request-auth lease", got)
			}
			if got := request.Header.Get("X-App"); got != testCase.leaseAppHeader {
				t.Fatalf("final X-App = %q, want current request-auth lease header %q", got, testCase.leaseAppHeader)
			}
			if got := request.Header.Get("X-Api-Key"); got != "" {
				t.Fatalf("registration-time X-Api-Key survived final transport = %q", got)
			}
			if got := request.Header.Get("X-Claude-Code-Session-Id"); got != "" {
				t.Fatalf("registration-time Claude session identity survived final transport = %q", got)
			}
			if got := request.Header.Get("Anthropic-Beta"); !strings.Contains(got, "claude-code-20250219") {
				t.Fatalf("Anthropic-Beta = %q, want pinned Claude executor shaping", got)
			}
			if got := request.Header.Get("Accept"); got != testCase.wantUpstreamAccept {
				t.Fatalf("upstream Accept = %q, want %q", got, testCase.wantUpstreamAccept)
			}

			var upstreamBody struct {
				Stream bool `json:"stream"`
				Tools  []struct {
					Name         string         `json:"name"`
					CacheControl map[string]any `json:"cache_control"`
				} `json:"tools"`
			}
			if errDecode := json.NewDecoder(request.Body).Decode(&upstreamBody); errDecode != nil {
				t.Fatalf("decode Claude upstream body: %v", errDecode)
			}
			if upstreamBody.Stream != testCase.wantStream {
				t.Fatalf("upstream stream = %v, want %v", upstreamBody.Stream, testCase.wantStream)
			}
			if len(upstreamBody.Tools) != 1 || upstreamBody.Tools[0].Name != "Bash" {
				t.Fatalf("upstream tools = %#v, want OAuth-shaped Bash tool", upstreamBody.Tools)
			}
			if testCase.wantStream && upstreamBody.Tools[0].CacheControl["type"] != "ephemeral" {
				t.Fatalf("streaming tool cache_control = %#v, want pinned executor injection", upstreamBody.Tools[0].CacheControl)
			}
			if !strings.Contains(responseBody, testCase.wantDownstreamFragment) {
				t.Fatalf("downstream body omitted %q: %s", testCase.wantDownstreamFragment, responseBody)
			}
			assertNoRuntimeStateFiles(t, cfg.RuntimeDir)
		})
	}
}

func TestPinnedSDKDoesNotReplayOrCoolDownManagedEntry(t *testing.T) {
	port := reserveLoopbackPort(t)
	cfg := Config{
		Host:             "127.0.0.1",
		Port:             port,
		DownstreamBearer: "downstream-session-bearer",
		RuntimeDir:       t.TempDir(),
		AuthEntries: []AuthEntry{
			testAuthEntry("codex", ProviderCodex, "openai-upstream"),
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
	_ = awaitManagedHealthIdentity(t, cfg)

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
					testAuthEntry("codex", ProviderCodex, "openai-upstream"),
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
			_ = awaitManagedHealthIdentity(t, cfg)

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
			testAuthEntry("codex", ProviderCodex, "openai-upstream"),
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
	_ = awaitManagedHealthIdentity(t, cfg)

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

func TestPinnedSDKWrapperIngressAcceptsOnlyExactSingleBearerBeforeSDKAuth(t *testing.T) {
	port := reserveLoopbackPort(t)
	cfg := Config{
		Host:             "127.0.0.1",
		Port:             port,
		DownstreamBearer: "downstream-session-bearer",
		RuntimeDir:       t.TempDir(),
		AuthEntries: []AuthEntry{
			testAuthEntry("codex", ProviderCodex, "openai-upstream"),
		},
		Protocols: []ProviderProtocol{ProtocolOpenAIResponses},
	}
	broker := &sequenceBroker{leases: []OAuthBearerLease{validLease("current-upstream", nil)}}
	upstream := &protocolFixtureRoundTripper{}
	gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
	if err != nil {
		t.Fatalf("NewGateway() error = %v", err)
	}
	cancel, runResult := runGateway(t, gateway)
	defer stopGateway(t, cancel, runResult)
	_ = awaitManagedHealthIdentity(t, cfg)
	headRequest, errRequest := http.NewRequest(
		http.MethodHead,
		fmt.Sprintf("http://%s:%d/healthz", cfg.Host, cfg.Port),
		nil,
	)
	if errRequest != nil {
		t.Fatalf("create health request: %v", errRequest)
	}
	headResponse, errRequest := http.DefaultClient.Do(headRequest)
	if errRequest != nil {
		t.Fatalf("health request: %v", errRequest)
	}
	_ = headResponse.Body.Close()
	if headResponse.StatusCode != http.StatusOK {
		t.Fatalf("unauthenticated HEAD health status = %d, want 200", headResponse.StatusCode)
	}

	doModelRequest := func(t *testing.T, path string, authorizations []string, headers http.Header) *http.Response {
		t.Helper()
		request, errRequest := http.NewRequest(
			http.MethodPost,
			fmt.Sprintf("http://%s:%d%s", cfg.Host, cfg.Port, path),
			strings.NewReader(`{"model":"gpt-5.5","input":"must remain at wrapper ingress"}`),
		)
		if errRequest != nil {
			t.Fatalf("create downstream request: %v", errRequest)
		}
		request.Header.Set("Content-Type", "application/json")
		for _, authorization := range authorizations {
			request.Header.Add("Authorization", authorization)
		}
		for name, values := range headers {
			for _, value := range values {
				request.Header.Add(name, value)
			}
		}
		response, errRequest := http.DefaultClient.Do(request)
		if errRequest != nil {
			t.Fatalf("downstream request: %v", errRequest)
		}
		return response
	}

	for _, testCase := range []struct {
		name           string
		path           string
		authorizations []string
		headers        http.Header
	}{
		{
			name:    "Google API key header",
			path:    "/v1/responses",
			headers: http.Header{"X-Goog-Api-Key": {cfg.DownstreamBearer}},
		},
		{
			name:    "Anthropic API key header",
			path:    "/v1/responses",
			headers: http.Header{"X-Api-Key": {cfg.DownstreamBearer}},
		},
		{
			name: "key query credential",
			path: "/v1/responses?key=" + cfg.DownstreamBearer,
		},
		{
			name: "auth token query credential",
			path: "/v1/responses?auth_token=" + cfg.DownstreamBearer,
		},
		{
			name:           "case-insensitive bearer scheme",
			path:           "/v1/responses",
			authorizations: []string{"bearer " + cfg.DownstreamBearer},
		},
		{
			name:           "bare authorization credential",
			path:           "/v1/responses",
			authorizations: []string{cfg.DownstreamBearer},
		},
		{
			name:           "authorization extra whitespace after scheme",
			path:           "/v1/responses",
			authorizations: []string{"Bearer  " + cfg.DownstreamBearer},
		},
		{
			name:           "multiple authorization headers",
			path:           "/v1/responses",
			authorizations: []string{"Bearer " + cfg.DownstreamBearer, "Bearer another-credential"},
		},
		{
			name:           "valid bearer plus alternate header",
			path:           "/v1/responses",
			authorizations: []string{"Bearer " + cfg.DownstreamBearer},
			headers:        http.Header{"X-Goog-Api-Key": {cfg.DownstreamBearer}},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			response := doModelRequest(t, testCase.path, testCase.authorizations, testCase.headers)
			body := readResponse(t, response)
			_ = response.Body.Close()
			if response.StatusCode != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", response.StatusCode)
			}
			if strings.Contains(body, cfg.DownstreamBearer) {
				t.Fatalf("unauthorized response exposed downstream bearer: %q", body)
			}
		})
	}
	if got := len(broker.purposes()); got != 0 {
		t.Fatalf("non-canonical downstream credentials reached request-auth broker %d times", got)
	}
	if got := len(upstream.requests()); got != 0 {
		t.Fatalf("non-canonical downstream credentials caused %d upstream effects", got)
	}

	managementRequest, errRequest := http.NewRequest(
		http.MethodGet,
		fmt.Sprintf("http://%s:%d/v0/management/config?key=%s", cfg.Host, cfg.Port, cfg.DownstreamBearer),
		nil,
	)
	if errRequest != nil {
		t.Fatalf("create management request: %v", errRequest)
	}
	managementResponse, errRequest := http.DefaultClient.Do(managementRequest)
	if errRequest != nil {
		t.Fatalf("management request: %v", errRequest)
	}
	_ = managementResponse.Body.Close()
	if managementResponse.StatusCode != http.StatusNotFound {
		t.Fatalf("management status = %d, want 404 before authentication", managementResponse.StatusCode)
	}

	response := doModelRequest(
		t,
		"/v1/responses",
		[]string{"Bearer " + cfg.DownstreamBearer},
		nil,
	)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("exact bearer downstream status = %d, body=%s", response.StatusCode, readResponse(t, response))
	}
	_ = response.Body.Close()
	if got := len(broker.purposes()); got != 1 {
		t.Fatalf("exact bearer request-auth broker lookups = %d, want 1", got)
	}
	if got := len(upstream.requests()); got != 1 {
		t.Fatalf("exact bearer upstream effects = %d, want 1", got)
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
			testAuthEntry("codex", ProviderCodex, "openai-upstream"),
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
	_ = awaitManagedHealthIdentity(t, cfg)

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
			testAuthEntry("codex", ProviderCodex, "openai-upstream"),
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
	_ = awaitManagedHealthIdentity(t, cfg)

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

func awaitManagedHealthIdentity(t *testing.T, cfg Config) ManagedHealthIdentity {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		response, err := http.Get(fmt.Sprintf(
			"http://%s:%d/healthz",
			cfg.Host,
			cfg.Port,
		))
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return getManagedHealthIdentity(t, cfg)
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("managed health did not become ready")
	return ManagedHealthIdentity{}
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
		if request.URL.Path == "/v1/messages/count_tokens" {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": {"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"input_tokens":7}`)),
				Request:    request,
			}, nil
		}
		if request.Header.Get("Accept") == "text/event-stream" {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": {"text/event-stream"}},
				Body: io.NopCloser(strings.NewReader(
					"event: message_start\n" +
						`data: {"type":"message_start","message":{"id":"msg_stream","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}` + "\n\n" +
						"event: content_block_start\n" +
						`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}` + "\n\n" +
						"event: content_block_delta\n" +
						`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}` + "\n\n" +
						"event: content_block_stop\n" +
						`data: {"type":"content_block_stop","index":0}` + "\n\n" +
						"event: message_delta\n" +
						`data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}` + "\n\n" +
						"event: message_stop\n" +
						`data: {"type":"message_stop"}` + "\n\n",
				)),
				Request: request,
			}, nil
		}
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
