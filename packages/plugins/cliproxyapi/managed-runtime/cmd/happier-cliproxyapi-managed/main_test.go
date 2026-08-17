package main

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	managedruntime "github.com/happier-dev/happier/packages/plugins/cliproxyapi/managed-runtime"
)

const fullyBoundPurposeConfiguration = `{"v":2,"purposes":[{"id":"codex","provider":"codex","consumer":{"pluginId":"happier.provider.cliproxyapi","localId":"cliproxyapi"},"purpose":"openai-upstream","allowedHttpsOrigin":"https://chatgpt.com","protocols":["openai-chat","openai-responses"]},{"id":"claude","provider":"claude","consumer":{"pluginId":"happier.provider.cliproxyapi","localId":"cliproxyapi"},"purpose":"anthropic-upstream","allowedHttpsOrigin":"https://api.anthropic.com","protocols":["anthropic"]}]}`

func TestParseArgumentsAcceptsOnlyNoArguments(t *testing.T) {
	t.Parallel()

	if err := parseArguments(nil); err != nil {
		t.Fatalf("parseArguments(nil) error = %v", err)
	}

	for _, args := range [][]string{
		{"--config"},
		{"--config", filepath.Join(t.TempDir(), "managed-runtime.json")},
		{"unexpected"},
	} {
		if err := parseArguments(args); err == nil {
			t.Fatalf("parseArguments(%#v) error = nil", args)
		}
	}
}

func TestMaterializeGatewayConfigReadsExactProcessEnvironmentAndImmutableFacts(t *testing.T) {
	t.Parallel()

	capabilityPath := filepath.Join(t.TempDir(), "capability.json")
	runtimeDir := filepath.Dir(filepath.Dir(capabilityPath))
	environment := map[string]string{
		"HOST": "127.0.0.1",
		"PORT": "32123",
		managedruntime.DownstreamBearerEnvironmentVariable:            "session-secret",
		managedruntime.RequestAuthCapabilityPathEnvironmentVariable:   capabilityPath,
		managedruntime.ManagedPurposeConfigurationEnvironmentVariable: fullyBoundPurposeConfiguration,
	}
	config, brokerConfig, err := materializeGatewayConfig(func(name string) (string, bool) {
		value, ok := environment[name]
		return value, ok
	})
	if err != nil {
		t.Fatalf("materializeGatewayConfig() error = %v", err)
	}
	if config.Host != "127.0.0.1" || config.Port != 32123 ||
		config.DownstreamBearer != "session-secret" || config.RuntimeDir != runtimeDir ||
		!config.ModelListEnabled {
		t.Fatalf("gateway config = %#v", config)
	}
	wantProtocols := []managedruntime.ProviderProtocol{
		managedruntime.ProtocolOpenAIChat,
		managedruntime.ProtocolOpenAIResponses,
		managedruntime.ProtocolAnthropic,
	}
	if !reflect.DeepEqual(config.Protocols, wantProtocols) {
		t.Fatalf("protocols = %#v, want %#v", config.Protocols, wantProtocols)
	}
	if len(config.AuthEntries) != 2 || config.AuthEntries[0].ID != "codex" ||
		config.AuthEntries[0].Provider != managedruntime.ProviderCodex ||
		config.AuthEntries[0].Purpose.Purpose != "openai-upstream" ||
		config.AuthEntries[0].AllowedHTTPSOrigin != "https://chatgpt.com" {
		t.Fatalf("auth entries = %#v", config.AuthEntries)
	}
	if config.AuthEntries[1].ID != "claude" ||
		config.AuthEntries[1].Provider != managedruntime.ProviderClaude ||
		config.AuthEntries[1].Purpose.Purpose != "anthropic-upstream" ||
		config.AuthEntries[1].AllowedHTTPSOrigin != "https://api.anthropic.com" {
		t.Fatalf("auth entries = %#v", config.AuthEntries)
	}
	if brokerConfig.CapabilityPath != capabilityPath {
		t.Fatalf("request-auth config = %#v", brokerConfig)
	}
}

func TestMaterializeGatewayConfigRejectsMissingOrMalformedEnvironmentWithoutEchoingSecrets(t *testing.T) {
	t.Parallel()

	valid := map[string]string{
		"HOST": "127.0.0.1",
		"PORT": "32123",
		managedruntime.DownstreamBearerEnvironmentVariable:            "secret-must-not-appear",
		managedruntime.RequestAuthCapabilityPathEnvironmentVariable:   filepath.Join(t.TempDir(), "capability.json"),
		managedruntime.ManagedPurposeConfigurationEnvironmentVariable: fullyBoundPurposeConfiguration,
	}
	for _, mutate := range []func(map[string]string){
		func(env map[string]string) { delete(env, "HOST") },
		func(env map[string]string) { delete(env, "PORT") },
		func(env map[string]string) { delete(env, managedruntime.DownstreamBearerEnvironmentVariable) },
		func(env map[string]string) { delete(env, managedruntime.RequestAuthCapabilityPathEnvironmentVariable) },
		func(env map[string]string) {
			delete(env, managedruntime.ManagedPurposeConfigurationEnvironmentVariable)
		},
		func(env map[string]string) { env["HOST"] = "0.0.0.0" },
		func(env map[string]string) { env["PORT"] = "70000" },
		func(env map[string]string) {
			env[managedruntime.DownstreamBearerEnvironmentVariable] = " secret-must-not-appear "
		},
		func(env map[string]string) {
			env[managedruntime.RequestAuthCapabilityPathEnvironmentVariable] = "relative"
		},
		func(env map[string]string) {
			env[managedruntime.RequestAuthCapabilityPathEnvironmentVariable] =
				filepath.Join(t.TempDir(), "capability.json") + "\x00forged"
		},
		func(env map[string]string) {
			env[managedruntime.ManagedPurposeConfigurationEnvironmentVariable] = "{}"
		},
	} {
		invalid := make(map[string]string, len(valid))
		for key, value := range valid {
			invalid[key] = value
		}
		mutate(invalid)
		_, _, err := materializeGatewayConfig(func(name string) (string, bool) {
			value, ok := invalid[name]
			return value, ok
		})
		if err == nil {
			t.Fatalf("materializeGatewayConfig() error = nil")
		}
		if strings.Contains(err.Error(), valid[managedruntime.DownstreamBearerEnvironmentVariable]) {
			t.Fatalf("error exposed downstream bearer: %v", err)
		}
	}
}

func TestMaterializeGatewayConfigUsesTheHostOwnedMaterializedRoot(t *testing.T) {
	t.Parallel()

	materializedRoot := t.TempDir()
	capabilityPath := filepath.Join(materializedRoot, "request-auth", "capability.json")
	environment := map[string]string{
		"HOST": "127.0.0.1",
		"PORT": "32123",
		managedruntime.DownstreamBearerEnvironmentVariable:            "session-secret",
		managedruntime.RequestAuthCapabilityPathEnvironmentVariable:   capabilityPath,
		managedruntime.ManagedPurposeConfigurationEnvironmentVariable: fullyBoundPurposeConfiguration,
	}
	config, _, err := materializeGatewayConfig(func(name string) (string, bool) {
		value, ok := environment[name]
		return value, ok
	})
	if err != nil {
		t.Fatalf("materializeGatewayConfig() error = %v", err)
	}
	if config.RuntimeDir != materializedRoot {
		t.Fatalf("runtime directory = %q, want host-owned materialized root %q", config.RuntimeDir, materializedRoot)
	}
}

func TestRunWithContextPreservesTheHostOwnedRootAcrossRestart(t *testing.T) {
	materializedRoot := t.TempDir()
	capabilityDirectory := filepath.Join(materializedRoot, "request-auth")
	if err := os.MkdirAll(capabilityDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	markerPath := filepath.Join(materializedRoot, "host-owned-marker")
	if err := os.WriteFile(markerPath, []byte("retain"), 0o600); err != nil {
		t.Fatal(err)
	}
	capabilityPath := filepath.Join(capabilityDirectory, "capability.json")

	for runIndex := 0; runIndex < 2; runIndex++ {
		port := reserveLoopbackPort(t)
		environment := map[string]string{
			"HOST": "127.0.0.1",
			"PORT": strconv.Itoa(port),
			managedruntime.DownstreamBearerEnvironmentVariable:            "session-secret",
			managedruntime.RequestAuthCapabilityPathEnvironmentVariable:   capabilityPath,
			managedruntime.ManagedPurposeConfigurationEnvironmentVariable: fullyBoundPurposeConfiguration,
		}
		runContext, cancel := context.WithCancel(context.Background())
		result := make(chan error, 1)
		go func() {
			result <- runWithContext(runContext, nil, func(name string) (string, bool) {
				value, ok := environment[name]
				return value, ok
			})
		}()
		awaitManagedHealth(t, port)
		cancel()
		select {
		case err := <-result:
			if err != nil {
				t.Fatalf("run %d shutdown = %v", runIndex+1, err)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("run %d did not stop", runIndex+1)
		}
	}

	if contents, err := os.ReadFile(markerPath); err != nil || string(contents) != "retain" {
		t.Fatalf("host-owned materialized root changed: contents=%q err=%v", contents, err)
	}
	if _, err := os.Stat(filepath.Join(capabilityDirectory, "cliproxyapi-runtime")); !os.IsNotExist(err) {
		t.Fatalf("wrapper-created child runtime directory remained: %v", err)
	}
}

func reserveLoopbackPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

func awaitManagedHealth(t *testing.T, port int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		response, err := http.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/healthz")
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("managed wrapper did not become HTTP healthy")
}
