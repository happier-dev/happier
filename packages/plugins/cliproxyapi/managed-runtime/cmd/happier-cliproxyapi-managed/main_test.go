package main

import (
	"path/filepath"
	"testing"

	managedruntime "github.com/happier-dev/happier/packages/plugins/cliproxyapi/managed-runtime"
)

func TestParseConfigPathAcceptsOnlyOneAbsoluteConfigArgument(t *testing.T) {
	t.Parallel()

	absolute := filepath.Join(t.TempDir(), "managed-runtime.json")
	got, err := parseConfigPath([]string{"--config", absolute})
	if err != nil {
		t.Fatalf("parseConfigPath() error = %v", err)
	}
	if got != absolute {
		t.Fatalf("config path = %q, want %q", got, absolute)
	}

	for _, args := range [][]string{
		nil,
		{"--config"},
		{"--config", "relative.json"},
		{"--config=" + absolute},
		{"--config", absolute, "unexpected"},
		{"--other", absolute},
	} {
		if _, err := parseConfigPath(args); err == nil {
			t.Fatalf("parseConfigPath(%#v) error = nil", args)
		}
	}
}

func TestValidateWrapperBuildVersionRequiresExactCompiledBinaryIdentity(t *testing.T) {
	t.Parallel()

	if err := validateWrapperBuildVersion("0.2.9", "0.2.9"); err != nil {
		t.Fatalf("matching build version rejected: %v", err)
	}
	for _, test := range []struct {
		configured string
		compiled   string
	}{
		{configured: "0.2.9", compiled: "0.2.10"},
		{configured: "", compiled: "0.2.9"},
		{configured: "0.2.9", compiled: ""},
	} {
		if err := validateWrapperBuildVersion(test.configured, test.compiled); err == nil {
			t.Fatalf("build mismatch %#v accepted", test)
		}
	}
}

func TestMaterializeGatewayConfigReadsOnlyStrictSVC09HostAndPort(t *testing.T) {
	t.Parallel()

	input := managedruntime.ProcessGatewayConfig{
		DownstreamBearer: "session-secret",
		RuntimeDir:       t.TempDir(),
		AuthEntries: []managedruntime.AuthEntry{{
			ID:       "codex",
			Provider: managedruntime.ProviderCodex,
			Purpose: managedruntime.QualifiedPurpose{
				Consumer: managedruntime.ContributionIdentity{
					PluginID: "happier.provider.cliproxyapi",
					LocalID:  "cliproxyapi",
				},
				Purpose: "openai-upstream",
			},
		}},
		Protocols: []managedruntime.ProviderProtocol{managedruntime.ProtocolOpenAIResponses},
	}
	environment := map[string]string{"HOST": "127.0.0.1", "PORT": "32123"}
	config, err := materializeGatewayConfig(input, func(name string) (string, bool) {
		value, ok := environment[name]
		return value, ok
	})
	if err != nil {
		t.Fatalf("materializeGatewayConfig() error = %v", err)
	}
	if config.Host != "127.0.0.1" || config.Port != 32123 {
		t.Fatalf("gateway endpoint = %s:%d", config.Host, config.Port)
	}

	for _, invalid := range []map[string]string{
		{"PORT": "32123"},
		{"HOST": "127.0.0.1"},
		{"HOST": "0.0.0.0", "PORT": "32123"},
		{"HOST": " 127.0.0.1", "PORT": "32123"},
		{"HOST": "127.0.0.1", "PORT": "not-a-port"},
		{"HOST": "127.0.0.1", "PORT": "70000"},
	} {
		if _, err := materializeGatewayConfig(input, func(name string) (string, bool) {
			value, ok := invalid[name]
			return value, ok
		}); err == nil {
			t.Fatalf("materializeGatewayConfig(%#v) error = nil", invalid)
		}
	}
}
