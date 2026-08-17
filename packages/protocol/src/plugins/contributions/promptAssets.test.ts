import { describe, expect, it } from 'vitest';

import { derivePluginDaemonContributionRegistrationRights } from './catalog.js';
import { PluginContributesV2Schema } from './v2.js';

const externalSkillAdapterDescriptor = Object.freeze({
  id: 'acme.skill',
  providerId: 'acme',
  title: 'Acme skills',
  description: 'Acme SKILL.md bundles.',
  libraryKind: 'bundle' as const,
  supportsScope: { user: true, project: true },
  supportsFiles: true,
  formatId: 'skill_md_v1',
  defaultRoots: [
    { label: 'Project skills', scope: 'project' as const, pathTemplate: '.acme/skills' },
  ],
  capabilities: { supportsCatalogInstall: true },
});

describe('plugin prompt asset contributions', () => {
  it('parses digest-resource prompt assets targeted to an Agent', () => {
    const parsed = PluginContributesV2Schema.parse({
      promptAssets: [
        {
          id: 'security-review',
          kind: 'systemPrompt',
          resource: 'security-review-prompt',
          target: { kind: 'agent', agent: 'deepsec' },
          priority: 20,
        },
      ],
    });

    expect(parsed.promptAssets).toEqual([
      {
        id: 'security-review',
        kind: 'systemPrompt',
        resource: 'security-review-prompt',
        target: { kind: 'agent', agent: 'deepsec' },
        priority: 20,
      },
    ]);
  });

  it('rejects provider-targeted prompt assets', () => {
    expect(() =>
      PluginContributesV2Schema.parse({
        promptAssets: [
          {
            id: 'security-review',
            kind: 'systemPrompt',
            resource: 'security-review-prompt',
            target: { kind: 'provider', provider: 'deepsec' },
          },
        ],
      }),
    ).toThrow();
  });

  it('admits an advertised external adapter and derives its exact registration right', () => {
    const parsed = PluginContributesV2Schema.parse({
      promptAssets: [{
        id: 'external-skills',
        kind: 'context',
        resource: 'skill-context',
        target: { kind: 'agent', agent: 'acme-agent' },
        adapterDescriptor: externalSkillAdapterDescriptor,
      }],
    });

    expect(parsed.promptAssets[0]?.adapterDescriptor).toEqual(externalSkillAdapterDescriptor);
    expect(derivePluginDaemonContributionRegistrationRights(parsed)).toContainEqual({
      family: 'promptAssets',
      localId: 'external-skills',
      target: { realm: 'daemon' },
      promptAssetDescriptor: externalSkillAdapterDescriptor,
    });
  });

  it('keeps descriptor-only prompt assets free of runtime registration demand', () => {
    const parsed = PluginContributesV2Schema.parse({
      promptAssets: [{
        id: 'static-context',
        kind: 'context',
        resource: 'static-context',
        target: { kind: 'agent', agent: 'acme-agent' },
      }],
    });

    expect(derivePluginDaemonContributionRegistrationRights(parsed)).not.toContainEqual(
      expect.objectContaining({ family: 'promptAssets' }),
    );
  });
});
