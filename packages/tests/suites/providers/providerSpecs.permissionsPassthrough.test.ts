import { describe, expect, it } from 'vitest';

import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/providerSpecs';

function expectModeMapKeys(map: unknown): void {
  expect(map).toBeTruthy();
  expect(map).toHaveProperty('default');
  expect(map).toHaveProperty('safe-yolo');
  expect(map).toHaveProperty('read-only');
  expect(map).toHaveProperty('yolo');
  expect(map).toHaveProperty('plan');
}

describe('providers: providerSpec permissions passthrough', () => {
  it('loads permissions config onto ProviderUnderTest objects', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const codex = providers.find((p) => p.id === 'codex');
    expect(codex).toBeTruthy();
    expect(codex?.permissions?.v).toBe(1);
    expect(codex?.permissions?.acp?.expectToolPermissionPrompts).toBe(false);
    expect(codex?.permissions?.acp?.permissionSurfaceOutsideWorkspaceYolo).toBe(false);
    expectModeMapKeys(codex?.permissions?.acp?.toolPermissionPromptsByMode);
    expect(codex?.permissions?.acp?.toolPermissionPromptsByMode?.default).toBe(false);
    expect(codex?.permissions?.acp?.toolPermissionPromptsByMode?.yolo).toBe(false);
    expectModeMapKeys(codex?.permissions?.acp?.outsideWorkspaceWriteAllowedByMode);
    expect(codex?.permissions?.acp?.outsideWorkspaceWriteAllowedByMode?.default).toBe(false);
    expect(codex?.permissions?.acp?.outsideWorkspaceWriteAllowedByMode?.yolo).toBe(false);
    expectModeMapKeys(codex?.permissions?.acp?.outsideWorkspaceWriteMustCompleteByMode);
    expect(codex?.permissions?.acp?.outsideWorkspaceWriteMustCompleteByMode?.default).toBe(false);
    expect(codex?.permissions?.acp?.outsideWorkspaceWriteMustCompleteByMode?.yolo).toBe(false);

    const opencode = providers.find((p) => p.id === 'opencode');
    expect(opencode).toBeTruthy();
    expect(opencode?.permissions?.v).toBe(1);
    expect(opencode?.permissions?.acp?.expectToolPermissionPrompts).toBe(false);
    expect(opencode?.permissions?.acp?.permissionSurfaceOutsideWorkspaceYolo).toBe(true);
    expectModeMapKeys(opencode?.permissions?.acp?.toolPermissionPromptsByMode);
    expect(opencode?.permissions?.acp?.toolPermissionPromptsByMode?.default).toBe(true);
    expect(opencode?.permissions?.acp?.toolPermissionPromptsByMode?.yolo).toBe(false);
    expectModeMapKeys(opencode?.permissions?.acp?.outsideWorkspaceWriteAllowedByMode);
    expect(opencode?.permissions?.acp?.outsideWorkspaceWriteAllowedByMode?.default).toBe(true);
    expect(opencode?.permissions?.acp?.outsideWorkspaceWriteAllowedByMode?.yolo).toBe(true);
    expectModeMapKeys(opencode?.permissions?.acp?.outsideWorkspaceWriteMustCompleteByMode);
    expect(opencode?.permissions?.acp?.outsideWorkspaceWriteMustCompleteByMode?.default).toBe(false);
    expect(opencode?.permissions?.acp?.outsideWorkspaceWriteMustCompleteByMode?.yolo).toBe(true);
    expectModeMapKeys(opencode?.permissions?.acp?.outsideWorkspaceRequireTaskCompleteByMode);
    expect(opencode?.permissions?.acp?.outsideWorkspaceRequireTaskCompleteByMode?.default).toBe(true);
    expect(opencode?.permissions?.acp?.outsideWorkspaceRequireTaskCompleteByMode?.yolo).toBe(true);

    const kilo = providers.find((p) => p.id === 'kilo');
    expect(kilo).toBeTruthy();
    expect(kilo?.permissions?.v).toBe(1);
    expect(kilo?.permissions?.acp?.expectToolPermissionPrompts).toBe(false);
    expect(kilo?.permissions?.acp?.permissionSurfaceOutsideWorkspaceYolo).toBe(true);
    expectModeMapKeys(kilo?.permissions?.acp?.toolPermissionPromptsByMode);
    expect(kilo?.permissions?.acp?.toolPermissionPromptsByMode?.default).toBe(true);
    expect(kilo?.permissions?.acp?.toolPermissionPromptsByMode?.yolo).toBe(false);
    expectModeMapKeys(kilo?.permissions?.acp?.outsideWorkspaceWriteAllowedByMode);
    expect(kilo?.permissions?.acp?.outsideWorkspaceWriteAllowedByMode?.default).toBe(true);
    expect(kilo?.permissions?.acp?.outsideWorkspaceWriteAllowedByMode?.yolo).toBe(true);
    expectModeMapKeys(kilo?.permissions?.acp?.outsideWorkspaceWriteMustCompleteByMode);
    expect(kilo?.permissions?.acp?.outsideWorkspaceWriteMustCompleteByMode?.default).toBe(false);
    expect(kilo?.permissions?.acp?.outsideWorkspaceWriteMustCompleteByMode?.yolo).toBe(true);
    expectModeMapKeys(kilo?.permissions?.acp?.outsideWorkspaceRequireTaskCompleteByMode);
    expect(kilo?.permissions?.acp?.outsideWorkspaceRequireTaskCompleteByMode?.default).toBe(true);
    expect(kilo?.permissions?.acp?.outsideWorkspaceRequireTaskCompleteByMode?.yolo).toBe(true);
  });
});
