package main

import (
	"path/filepath"
	"reflect"
	"testing"

	managedruntime "github.com/happier-dev/happier/packages/plugins/cliproxyapi/managed-runtime"
)

func TestMaterializeGatewayConfigDerivesOnlyTheBoundPurposeFamilies(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name          string
		purposeConfig string
		wantProtocols []managedruntime.ProviderProtocol
		wantEntryIDs  []string
		wantPurposes  []string
	}{
		{
			name:          "OpenAI only",
			purposeConfig: `{"v":2,"modelListEnabled":true,"purposes":[{"id":"codex","provider":"codex","consumer":{"pluginId":"happier.provider.cliproxyapi","localId":"cliproxyapi"},"purpose":"openai-upstream","allowedHttpsOrigin":"https://chatgpt.com","protocols":["openai-chat","openai-responses"]}]}`,
			wantProtocols: []managedruntime.ProviderProtocol{
				managedruntime.ProtocolOpenAIChat,
				managedruntime.ProtocolOpenAIResponses,
			},
			wantEntryIDs: []string{"codex"},
			wantPurposes: []string{"openai-upstream"},
		},
		{
			name:          "Claude only",
			purposeConfig: `{"v":2,"modelListEnabled":true,"purposes":[{"id":"claude","provider":"claude","consumer":{"pluginId":"happier.provider.cliproxyapi","localId":"cliproxyapi"},"purpose":"anthropic-upstream","allowedHttpsOrigin":"https://api.anthropic.com","protocols":["anthropic"]}]}`,
			wantProtocols: []managedruntime.ProviderProtocol{
				managedruntime.ProtocolAnthropic,
			},
			wantEntryIDs: []string{"claude"},
			wantPurposes: []string{"anthropic-upstream"},
		},
		{
			name:          "both families",
			purposeConfig: `{"v":2,"modelListEnabled":true,"purposes":[{"id":"codex","provider":"codex","consumer":{"pluginId":"happier.provider.cliproxyapi","localId":"cliproxyapi"},"purpose":"openai-upstream","allowedHttpsOrigin":"https://chatgpt.com","protocols":["openai-chat","openai-responses"]},{"id":"claude","provider":"claude","consumer":{"pluginId":"happier.provider.cliproxyapi","localId":"cliproxyapi"},"purpose":"anthropic-upstream","allowedHttpsOrigin":"https://api.anthropic.com","protocols":["anthropic"]}]}`,
			wantProtocols: []managedruntime.ProviderProtocol{
				managedruntime.ProtocolOpenAIChat,
				managedruntime.ProtocolOpenAIResponses,
				managedruntime.ProtocolAnthropic,
			},
			wantEntryIDs: []string{"codex", "claude"},
			wantPurposes: []string{"openai-upstream", "anthropic-upstream"},
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			capabilityPath := filepath.Join(t.TempDir(), "capability.json")
			environment := map[string]string{
				"HOST": "127.0.0.1",
				"PORT": "32123",
				managedruntime.DownstreamBearerEnvironmentVariable:            "session-secret",
				managedruntime.RequestAuthCapabilityPathEnvironmentVariable:   capabilityPath,
				managedruntime.ManagedPurposeConfigurationEnvironmentVariable: testCase.purposeConfig,
			}
			config, _, err := materializeGatewayConfig(func(name string) (string, bool) {
				value, ok := environment[name]
				return value, ok
			})
			if err != nil {
				t.Fatalf("materializeGatewayConfig() error = %v", err)
			}
			if !reflect.DeepEqual(config.Protocols, testCase.wantProtocols) {
				t.Fatalf("protocols = %#v, want %#v", config.Protocols, testCase.wantProtocols)
			}
			if len(config.AuthEntries) != len(testCase.wantEntryIDs) {
				t.Fatalf("auth entries = %#v", config.AuthEntries)
			}
			for index, entry := range config.AuthEntries {
				if entry.ID != testCase.wantEntryIDs[index] || entry.Purpose.Purpose != testCase.wantPurposes[index] {
					t.Fatalf("auth entry %d = %#v, want id=%q purpose=%q", index, entry, testCase.wantEntryIDs[index], testCase.wantPurposes[index])
				}
			}
		})
	}
}

func TestMaterializeGatewayConfigRejectsAnEmptyOrForgedPurposeSnapshot(t *testing.T) {
	t.Parallel()

	for _, purposeConfig := range []string{
		`{"v":2,"modelListEnabled":true,"purposes":[]}`,
		`{"v":2,"modelListEnabled":true,"purposes":[{"id":"codex","provider":"codex","consumer":{"pluginId":"happier.provider.cliproxyapi","localId":"cliproxyapi"},"purpose":"openai-upstream","allowedHttpsOrigin":"https://chatgpt.com","protocols":["openai-chat","openai-responses"],"credential":"forged"}]}`,
		`{"v":2,"modelListEnabled":true,"purposes":[{"id":"claude","provider":"claude","consumer":{"pluginId":"happier.provider.cliproxyapi","localId":"cliproxyapi"},"purpose":"anthropic-upstream","allowedHttpsOrigin":"https://api.anthropic.com","protocols":["unsupported"]}]}`,
		`{"v":2,"modelListEnabled":true,"purposes":[{"id":"codex","provider":"codex","consumer":{"pluginId":"happier.provider.cliproxyapi","localId":"cliproxyapi"},"purpose":"openai-upstream","allowedHttpsOrigin":"https://chatgpt.com","protocols":["openai-chat","openai-responses"]},{"id":"codex-duplicate","provider":"codex","consumer":{"pluginId":"happier.provider.cliproxyapi","localId":"cliproxyapi"},"purpose":"openai-other","allowedHttpsOrigin":"https://chatgpt.com","protocols":["anthropic"]}]}`,
		`{"v":1,"purposes":["openai-upstream"],"protocols":["openai-chat","openai-responses"]}`,
	} {
		capabilityPath := filepath.Join(t.TempDir(), "capability.json")
		environment := map[string]string{
			"HOST": "127.0.0.1",
			"PORT": "32123",
			managedruntime.DownstreamBearerEnvironmentVariable:            "session-secret",
			managedruntime.RequestAuthCapabilityPathEnvironmentVariable:   capabilityPath,
			managedruntime.ManagedPurposeConfigurationEnvironmentVariable: purposeConfig,
		}
		_, _, err := materializeGatewayConfig(func(name string) (string, bool) {
			value, ok := environment[name]
			return value, ok
		})
		if err == nil {
			t.Fatalf("materializeGatewayConfig(%q) error = nil", purposeConfig)
		}
	}
}
