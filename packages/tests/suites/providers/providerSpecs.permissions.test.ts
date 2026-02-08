import { describe, expect, it } from 'vitest';

import { E2eCliProviderSpecV1Schema } from '@happier-dev/protocol';

describe('providers: providerSpec permissions', () => {
  it('preserves permissions.acp.expectToolPermissionPrompts from providerSpec.json', () => {
    const parsed = E2eCliProviderSpecV1Schema.parse({
      v: 1,
      id: 'example',
      enableEnvVar: 'HAPPIER_E2E_PROVIDER_EXAMPLE',
      protocol: 'acp',
      traceProvider: 'example',
      permissions: {
        v: 1,
        acp: {
          expectToolPermissionPrompts: false,
        },
      },
      cli: {
        subcommand: 'example',
      },
    });

    expect(parsed.permissions).toEqual({
      v: 1,
      acp: {
        expectToolPermissionPrompts: false,
      },
    });
  });

  it('preserves permissions.acp.toolPermissionPromptsByMode from providerSpec.json', () => {
    const parsed = E2eCliProviderSpecV1Schema.parse({
      v: 1,
      id: 'example',
      enableEnvVar: 'HAPPIER_E2E_PROVIDER_EXAMPLE',
      protocol: 'acp',
      traceProvider: 'example',
      permissions: {
        v: 1,
        acp: {
          toolPermissionPromptsByMode: {
            default: true,
            'safe-yolo': true,
            'read-only': false,
            yolo: false,
            plan: false,
          },
          outsideWorkspaceWriteAllowedByMode: {
            default: true,
            'safe-yolo': true,
            'read-only': false,
            yolo: true,
            plan: false,
          },
          outsideWorkspaceWriteMustCompleteByMode: {
            default: true,
            'safe-yolo': true,
            'read-only': false,
            yolo: true,
            plan: false,
          },
        },
      },
      cli: {
        subcommand: 'example',
      },
    });

    expect(parsed.permissions).toEqual({
      v: 1,
      acp: {
        toolPermissionPromptsByMode: {
          default: true,
          'safe-yolo': true,
          'read-only': false,
          yolo: false,
          plan: false,
        },
        outsideWorkspaceWriteAllowedByMode: {
          default: true,
          'safe-yolo': true,
          'read-only': false,
          yolo: true,
          plan: false,
        },
        outsideWorkspaceWriteMustCompleteByMode: {
          default: true,
          'safe-yolo': true,
          'read-only': false,
          yolo: true,
          plan: false,
        },
      },
    });
  });

  it('preserves permissions.acp.permissionSurfaceOutsideWorkspaceYolo from providerSpec.json', () => {
    const parsed = E2eCliProviderSpecV1Schema.parse({
      v: 1,
      id: 'example',
      enableEnvVar: 'HAPPIER_E2E_PROVIDER_EXAMPLE',
      protocol: 'acp',
      traceProvider: 'example',
      permissions: {
        v: 1,
        acp: {
          permissionSurfaceOutsideWorkspaceYolo: true,
        },
      },
      cli: {
        subcommand: 'example',
      },
    });

    expect(parsed.permissions).toEqual({
      v: 1,
      acp: {
        permissionSurfaceOutsideWorkspaceYolo: true,
      },
    });
  });
});
