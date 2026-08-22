package managedruntime

import "testing"

func TestManagedPurposeConfigurationRequiresAndPropagatesModelListDeclaration(t *testing.T) {
	t.Parallel()

	for _, testCase := range []struct {
		name               string
		configuration      string
		wantModelListRoute bool
	}{
		{
			name:               "enabled",
			configuration:      `{"v":2,"modelListEnabled":true,"purposes":[{"id":"claude","provider":"claude","consumer":{"pluginId":"happier.provider.cliproxyapi","localId":"cliproxyapi"},"purpose":"anthropic-upstream","allowedHttpsOrigin":"https://api.anthropic.com","protocols":["anthropic"]}]}`,
			wantModelListRoute: true,
		},
		{
			name:               "disabled",
			configuration:      `{"v":2,"modelListEnabled":false,"purposes":[{"id":"claude","provider":"claude","consumer":{"pluginId":"happier.provider.cliproxyapi","localId":"cliproxyapi"},"purpose":"anthropic-upstream","allowedHttpsOrigin":"https://api.anthropic.com","protocols":["anthropic"]}]}`,
			wantModelListRoute: false,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			purposeConfiguration, err := ParseManagedPurposeConfiguration(testCase.configuration)
			if err != nil {
				t.Fatalf("ParseManagedPurposeConfiguration() error = %v", err)
			}
			config, err := ImmutableGatewayConfig(
				"127.0.0.1",
				32123,
				"session-secret",
				t.TempDir(),
				purposeConfiguration,
			)
			if err != nil {
				t.Fatalf("ImmutableGatewayConfig() error = %v", err)
			}
			routes, err := servingRoutesForProtocols(config.Protocols, config.ModelListEnabled)
			if err != nil {
				t.Fatalf("servingRoutesForProtocols() error = %v", err)
			}
			_, hasModelListRoute := routes[Route{Method: "GET", Path: "/v1/models"}]
			if hasModelListRoute != testCase.wantModelListRoute {
				t.Fatalf(
					"model-list route present = %t, want %t",
					hasModelListRoute,
					testCase.wantModelListRoute,
				)
			}
		})
	}

	_, err := ParseManagedPurposeConfiguration(
		`{"v":2,"purposes":[{"id":"claude","provider":"claude","consumer":{"pluginId":"happier.provider.cliproxyapi","localId":"cliproxyapi"},"purpose":"anthropic-upstream","allowedHttpsOrigin":"https://api.anthropic.com","protocols":["anthropic"]}]}`,
	)
	if err == nil {
		t.Fatal("ParseManagedPurposeConfiguration() accepted a missing model-list declaration")
	}
}
