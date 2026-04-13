import { describe, expect, it } from 'vitest';

import {
  CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
  isClaudeLocalPermissionBridgeAgentStateRequest,
  getProviderCliSetupRecommendedIds,
  getProviderCliSetupSupportedIds,
  getAllProviderDefinitions,
  getAllProviderDefinitionContracts,
  getAllBackendDefinitions,
  getAllBackendDefinitionContracts,
  getProviderDefinition,
  getProviderDefinitionContract,
  getBackendDefinition,
  getBackendDefinitionContract,
} from './index.js';
import {
  CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE as CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE_FROM_CLAUDE_INDEX,
  isClaudeLocalPermissionBridgeAgentStateRequest as isClaudeLocalPermissionBridgeAgentStateRequestFromClaudeIndex,
} from './providers/claude/index.js';
import {
  getProviderCliSetupRecommendedIds as getProviderCliSetupRecommendedIdsFromProviderRuntime,
  getProviderCliSetupSupportedIds as getProviderCliSetupSupportedIdsFromProviderRuntime,
} from './providers/providerCliRuntime.js';

describe('agents package exports', () => {
  it('re-exports the Claude local permission bridge helper from the package root', () => {
    expect(CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE).toBe('claude_local_permission_bridge');
    expect(isClaudeLocalPermissionBridgeAgentStateRequest({ source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE })).toBe(true);
    expect(isClaudeLocalPermissionBridgeAgentStateRequest({ source: 'other' })).toBe(false);
  });

  it('re-exports the Claude local permission bridge helper from the Claude provider entrypoint', () => {
    expect(CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE_FROM_CLAUDE_INDEX).toBe('claude_local_permission_bridge');
    expect(isClaudeLocalPermissionBridgeAgentStateRequestFromClaudeIndex({
      source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE_FROM_CLAUDE_INDEX,
    })).toBe(true);
    expect(isClaudeLocalPermissionBridgeAgentStateRequestFromClaudeIndex({ source: 'other' })).toBe(false);
  });

  it('re-exports the provider setup helper lists from the package root', () => {
    expect(getProviderCliSetupSupportedIds()).toEqual(getProviderCliSetupSupportedIdsFromProviderRuntime());
    expect(getProviderCliSetupRecommendedIds()).toEqual(getProviderCliSetupRecommendedIdsFromProviderRuntime());
  });

  it('re-exports the canonical provider and backend definition registry helpers from the package root', () => {
    expect(typeof getAllProviderDefinitions).toBe('function');
    expect(typeof getAllProviderDefinitionContracts).toBe('function');
    expect(typeof getAllBackendDefinitions).toBe('function');
    expect(typeof getAllBackendDefinitionContracts).toBe('function');
    expect(typeof getProviderDefinition).toBe('function');
    expect(typeof getProviderDefinitionContract).toBe('function');
    expect(typeof getBackendDefinition).toBe('function');
    expect(typeof getBackendDefinitionContract).toBe('function');
  });
});
