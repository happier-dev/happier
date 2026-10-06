import { describe, expect, it } from 'vitest';

import { renderCliPromptAssetPluginDescriptorsTs } from './registry';
import { renderBundledUiBehaviorOverridesTs } from './agentUi';
import { CLAUDE_PREDECESSOR_MESSAGE_META_DEFAULTS, buildClaudePredecessorMessageMeta as buildPluginMeta } from '../../../../../packages/plugins/claude/src/ui/predecessorMessageMeta';
import { buildClaudePredecessorMessageMeta } from '@happier-dev/protocol/agents/claude/predecessor-message-meta';

describe('bundled prompt asset projection', () => {
  it('publishes descriptor data without an executable plugin import', () => {
    const descriptor = {
      adapterKind: 'markdownDoc', assetTypeId: 'claude.command', providerId: 'claude',
      title: 'Commands', description: 'Slash commands',
      projectRootPath: ['.claude', 'commands'], projectRootDisplayPath: '.claude/commands',
      userRootPath: ['.claude', 'commands'], userRootDisplayPath: '~/.claude/commands',
    };
    const output = renderCliPromptAssetPluginDescriptorsTs([{
      pluginPackageId: 'claude',
      descriptors: [descriptor],
    }]);
    expect(output).not.toContain('@happier-dev/plugins-claude');
    const serialized = output.match(/Object\.freeze\(([\s\S]*)\);/u)?.[1];
    expect(JSON.parse(serialized!)).toEqual([descriptor]);
    const excluded = renderCliPromptAssetPluginDescriptorsTs([]);
    expect(JSON.parse(excluded.match(/Object\.freeze\(([\s\S]*)\);/u)![1]!)).toEqual([]);
  });
});

describe('bundled predecessor message metadata projection', () => {
  it('keeps the compatibility writer independent of executable plugin packages', () => {
    const output = renderBundledUiBehaviorOverridesTs([{
      agentId: 'claude', descriptor: {},
      predecessorMessageMetaWriter: {
        importName: 'buildClaudePredecessorMessageMeta',
        importPath: '@happier-dev/protocol/agents/claude/predecessor-message-meta',
        defaults: { claudeRemoteAgentSdkEnabled: true },
      },
    }]);
    expect(output).not.toContain('@happier-dev/plugins-claude');
    // A bound constant, not a fresh literal: later plugin settings must not trip
    // the protocol defaults type's excess-property check.
    expect(output).toContain('buildClaudePredecessorMessageMeta(settings, BUNDLED_CLAUDE_PREDECESSOR_MESSAGE_META_DEFAULTS)');
    expect(output).toContain('"claudeRemoteAgentSdkEnabled": true');
    expect(renderBundledUiBehaviorOverridesTs([])).not.toContain('buildClaudePredecessorMessageMeta');
  });

  it('preserves the present-plugin writer through projected defaults, including malformed settings', () => {
    const output = renderBundledUiBehaviorOverridesTs([{
      agentId: 'claude', descriptor: {},
      predecessorMessageMetaWriter: {
        importName: 'buildClaudePredecessorMessageMeta',
        importPath: '@happier-dev/protocol/agents/claude/predecessor-message-meta',
        defaults: CLAUDE_PREDECESSOR_MESSAGE_META_DEFAULTS,
      },
    }]);
    const projectedDefaults = JSON.parse(output.match(
      /const BUNDLED_CLAUDE_PREDECESSOR_MESSAGE_META_DEFAULTS = Object\.freeze\((\{[\s\S]*?\})\);/u,
    )![1]!);
    for (const settings of [{}, {
      claudeRemoteAgentSdkEnabled: false,
      claudeRemoteSettingSources: 'none',
      claudeRemoteAdvancedOptionsJson: ' { "betas": ["agent-teams"] } ',
    }, {
      claudeUnifiedTerminalHost: 'invalid',
      claudeRemoteSettingSourcesV2: ['invalid'],
      claudeRemoteDebugCategories: ['invalid'],
      claudeRemoteAdvancedOptionsJson: '[1]',
    }]) {
      expect(buildClaudePredecessorMessageMeta(settings, projectedDefaults)).toEqual(buildPluginMeta(settings));
    }
    expect(buildClaudePredecessorMessageMeta({
      claudeRemoteAgentSdkEnabled: false,
      claudeRemoteSettingSources: 'none',
    }, projectedDefaults)).toMatchObject({
      claudeRemoteAgentSdkEnabled: false, claudeRemoteSettingSources: 'none',
      claudeRemoteSettingSourcesV2: [],
    });
  });
});
