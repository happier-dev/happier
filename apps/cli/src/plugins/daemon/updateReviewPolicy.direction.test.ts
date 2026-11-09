import { describe, expect, it } from 'vitest';

import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { validatePluginManifest } from '@/plugins/manifest/validate';
import {
  createDefaultPluginAccessScopeRegistry,
  type PluginAccessSelection,
} from '@/plugins/store/install/accessScopeRegistry';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import {
  evaluatePluginAuthorityReview,
  hasPluginAuthorityExpansion,
  listPluginAuthorityExpansions,
  preserveValidPluginOptionalSelections,
} from './updateReviewPolicy';

const PLUGIN_ID = 'acme.direction';
const registry = createDefaultPluginAccessScopeRegistry();

function manifest(overrides: Readonly<Record<string, unknown>>) {
  const parsed = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id: PLUGIN_ID,
    ...overrides,
  }));
  if (!parsed) throw new Error('Expected a canonical direction fixture manifest');
  return parsed;
}

function networkManifest(options: Readonly<{
  origins: readonly string[];
  methods?: readonly string[];
  reason?: string;
  omitRequired?: boolean;
}>) {
  return manifest({
    hostAccess: {
      required: options.omitRequired ? [] : [{
        id: 'api',
        capability: 'network',
        reason: options.reason ?? 'Talk to the Example API',
        scope: {
          targets: options.origins.map((origin) => ({ kind: 'fixedOrigin', origin })),
          ...(options.methods ? { methods: [...options.methods] } : {}),
        },
      }],
      optional: [],
    },
  });
}

function sessionsOptionalManifest(access: readonly string[], extraOptional = false) {
  return manifest({
    hostAccess: {
      required: [],
      optional: [
        {
          id: 'sessions',
          capability: 'sessions',
          reason: 'Read your sessions',
          scope: { access: [...access] },
        },
        ...(extraOptional
          ? [{
              id: 'accounts',
              capability: 'connectedAccounts',
              reason: 'Use a Connected Account',
              scope: {
                serviceRefs: ['account'],
                operations: ['select', 'use'],
                materializationKinds: ['environment', 'files'],
              },
            }]
          : []),
      ],
    },
  });
}

function sessionsSelection(access: readonly string[]): PluginAccessSelection {
  return registry.createSelection({
    pluginId: PLUGIN_ID,
    accessId: 'sessions',
    capability: 'sessions',
    scope: { access: [...access] },
    selectedAtMs: 7,
  });
}

function agentPurposeManifest(materializationKinds?: readonly string[], extraPurpose = false) {
  return manifest({
    contributes: {
      agents: [{
        id: 'consumer',
        title: 'Consumer',
        runtime: { kind: 'custom' },
        primary: 'sessions',
        connectedAccounts: [
          {
            purpose: 'upstream',
            service: 'account',
            ...(materializationKinds ? { materializationKinds: [...materializationKinds] } : {}),
          },
          ...(extraPurpose
            ? [{ purpose: 'secondary', service: 'account' }]
            : []),
        ],
        capabilities: {
          sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
        },
      }],
    },
  });
}

function interceptorManifest(options: Readonly<{
  origins: readonly string[];
  methods?: readonly string[];
  priority?: number;
}>) {
  return manifest({
    contributes: {
      requestInterceptors: [{
        id: 'protect-api',
        origins: [...options.origins],
        ...(options.methods ? { methods: [...options.methods] } : {}),
        ...(options.priority === undefined ? {} : { priority: options.priority }),
      }],
    },
  });
}

function rawCredentialManifest(options: Readonly<{
  headerNames?: readonly string[];
  secretKinds?: readonly string[];
  slotTitle?: string;
}> = {}) {
  const result = validatePluginManifest({
    schemaVersion: 2,
    id: 'acme.direction.voice',
    version: '1.0.0',
    displayName: 'Direction voice',
    engines: { happier: '>=0.0.0' },
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './dist/daemon.mjs' },
    hostAccess: { required: [], optional: [] },
    contributes: {
      voiceProviders: [{
        id: 'raw-voice',
        title: 'Raw Voice',
        kind: 'conversation',
        roles: ['realtime_conversation'],
        platforms: ['web'],
        capabilities: { turn: { cancelResponse: false, bargeIn: false } },
        credentials: {
          slot: {
            id: 'voice_auth',
            purpose: 'voice.client-auth',
            title: options.slotTitle ?? 'Voice credential',
          },
          requirement: { kind: 'always' },
          sources: [{
            kind: 'savedSecret',
            secretKinds: [...(options.secretKinds ?? ['apiKey', 'token'])],
            rawGrants: [{
              realm: 'web',
              phase: 'connection',
              request: {
                kind: 'httpHeaders',
                origin: 'https://voice.example.test',
                headerNames: [...(options.headerNames ?? ['authorization', 'x-tenant'])],
              },
            }],
          }],
        },
        client: {
          artifactId: 'raw-voice-client',
          exportName: 'activate',
        },
      }],
    },
  }, { sourceProvenance: 'registryCustodied' });
  if (!result.ok) throw new Error(`Fixture manifest rejected: ${JSON.stringify(result.diagnostics)}`);
  return result.manifest;
}

describe('hasPluginAuthorityExpansion is directional', () => {
  it('does not reopen review for disclosure copy that grants no new authority', () => {
    const previous = networkManifest({ origins: ['https://api.example.test'] });
    const reworded = networkManifest({
      origins: ['https://api.example.test'],
      reason: 'Talk to the Example API on your behalf',
    });

    expect(hasPluginAuthorityExpansion(previous, reworded, [])).toBe(false);
  });

  it('reopens review for a new or widened required host-access declaration', () => {
    const previous = networkManifest({ origins: ['https://api.example.test'] });

    expect(hasPluginAuthorityExpansion(
      previous,
      networkManifest({ origins: ['https://api.example.test', 'https://accounts.example.test'] }),
      [],
    )).toBe(true);
    expect(listPluginAuthorityExpansions(
      previous,
      networkManifest({ origins: ['https://api.example.test', 'https://accounts.example.test'] }),
      [],
    )).toEqual(['requiredHostAccess']);
    expect(hasPluginAuthorityExpansion(
      networkManifest({ origins: ['https://api.example.test'], methods: ['GET'] }),
      previous,
      [],
    )).toBe(true);
    expect(hasPluginAuthorityExpansion(
      networkManifest({ origins: ['https://api.example.test'], omitRequired: true }),
      previous,
      [],
    )).toBe(true);
  });

  it('does not reopen review for a removed or narrowed required host-access declaration', () => {
    const previous = networkManifest({
      origins: ['https://api.example.test', 'https://accounts.example.test'],
    });

    expect(hasPluginAuthorityExpansion(
      previous,
      networkManifest({ origins: ['https://api.example.test'] }),
      [],
    )).toBe(false);
    expect(hasPluginAuthorityExpansion(
      previous,
      networkManifest({ origins: ['https://api.example.test'], omitRequired: true }),
      [],
    )).toBe(false);
    expect(hasPluginAuthorityExpansion(
      previous,
      networkManifest({
        origins: ['https://api.example.test', 'https://accounts.example.test'],
        methods: ['GET'],
      }),
      [],
    )).toBe(false);
  });

  it('does not reopen review for an added or widened optional declaration the user never selected', () => {
    const previous = sessionsOptionalManifest(['read']);

    expect(hasPluginAuthorityExpansion(
      previous,
      sessionsOptionalManifest(['read', 'write', 'control']),
      [],
    )).toBe(false);
    expect(hasPluginAuthorityExpansion(
      previous,
      sessionsOptionalManifest(['read'], true),
      [],
    )).toBe(false);
  });

  it('reopens review when a selected optional declaration widens beyond the granted scope', () => {
    const selections = [sessionsSelection(['read'])];

    expect(hasPluginAuthorityExpansion(
      sessionsOptionalManifest(['read']),
      sessionsOptionalManifest(['read', 'write']),
      selections,
    )).toBe(true);
  });

  it('does not reopen review when a selected optional declaration narrows inside the granted scope', () => {
    const selections = [sessionsSelection(['read', 'write'])];

    expect(hasPluginAuthorityExpansion(
      sessionsOptionalManifest(['read', 'write']),
      sessionsOptionalManifest(['read']),
      selections,
    )).toBe(false);
  });

  it('reopens review only when Connected Account purpose authority expands', () => {
    const wide = agentPurposeManifest(['environment', 'files']);
    const narrow = agentPurposeManifest(['environment']);

    expect(hasPluginAuthorityExpansion(narrow, wide, [])).toBe(true);
    expect(hasPluginAuthorityExpansion(wide, narrow, [])).toBe(false);
    expect(hasPluginAuthorityExpansion(wide, agentPurposeManifest(), [])).toBe(false);
    expect(hasPluginAuthorityExpansion(narrow, agentPurposeManifest(['environment'], true), []))
      .toBe(true);
  });

  it('reopens review only when request-interceptor reach expands', () => {
    const previous = interceptorManifest({
      origins: ['https://api.example.test', 'https://accounts.example.test'],
      methods: ['GET', 'POST'],
      priority: 10,
    });

    expect(hasPluginAuthorityExpansion(
      previous,
      interceptorManifest({ origins: ['https://api.example.test'], methods: ['GET'], priority: 20 }),
      [],
    )).toBe(false);
    expect(hasPluginAuthorityExpansion(
      previous,
      interceptorManifest({
        origins: ['https://api.example.test', 'https://accounts.example.test', 'https://cdn.example.test'],
        methods: ['GET', 'POST'],
        priority: 10,
      }),
      [],
    )).toBe(true);
    expect(hasPluginAuthorityExpansion(
      previous,
      interceptorManifest({
        origins: ['https://api.example.test', 'https://accounts.example.test'],
        priority: 10,
      }),
      [],
    )).toBe(true);
    expect(hasPluginAuthorityExpansion(
      previous,
      interceptorManifest({
        origins: ['https://api.example.test', 'https://accounts.example.test'],
        methods: ['GET', 'POST'],
        priority: 5,
      }),
      [],
    )).toBe(false);
  });

  it('reopens review only when raw-credential reach expands', () => {
    const previous = rawCredentialManifest();

    expect(hasPluginAuthorityExpansion(
      previous,
      rawCredentialManifest({ headerNames: ['authorization'], secretKinds: ['apiKey'] }),
      [],
    )).toBe(false);
    expect(hasPluginAuthorityExpansion(
      previous,
      rawCredentialManifest({ slotTitle: 'Voice credential (v2)' }),
      [],
    )).toBe(false);
    expect(hasPluginAuthorityExpansion(
      previous,
      rawCredentialManifest({ headerNames: ['authorization', 'x-tenant', 'x-admin'] }),
      [],
    )).toBe(true);
    expect(hasPluginAuthorityExpansion(
      previous,
      rawCredentialManifest({ secretKinds: ['apiKey', 'token', 'password'] }),
      [],
    )).toBe(true);
  });
});

describe('preserveValidPluginOptionalSelections follows a narrowed declaration', () => {
  it('keeps the granted selection narrowed to the current declaration', () => {
    const preserved = preserveValidPluginOptionalSelections(
      PLUGIN_ID,
      sessionsOptionalManifest(['read']),
      [sessionsSelection(['read', 'write'])],
    );

    expect(preserved).toEqual([sessionsSelection(['read'])]);
  });

  it('refuses a selection the current declaration widens beyond', () => {
    expect(preserveValidPluginOptionalSelections(
      PLUGIN_ID,
      sessionsOptionalManifest(['read', 'write']),
      [sessionsSelection(['read'])],
    )).toBeNull();
  });

  it('reopens review when a stale optional selection cannot be preserved', () => {
    expect(evaluatePluginAuthorityReview({
      previous: sessionsOptionalManifest(['read']),
      candidate: sessionsOptionalManifest(['read', 'write']),
      selectedOptionalAccess: [sessionsSelection(['read'])],
    })).toMatchObject({
      requiresReview: true,
      authorityExpansion: expect.arrayContaining(['selectedOptionalHostAccess']),
      preservedOptionalAccess: null,
    });
  });
});

describe('evaluatePluginAuthorityReview applies the user update review mode', () => {
  const previous = networkManifest({ origins: ['https://api.example.test'] });
  const widened = networkManifest({ origins: ['https://api.example.test', 'https://accounts.example.test'] });

  it('confirms a reach expansion by default and when the Account setting asks to confirm', () => {
    expect(evaluatePluginAuthorityReview({
      previous,
      candidate: widened,
      selectedOptionalAccess: [],
      readAccountSettings: () => null,
    })).toMatchObject({ requiresReview: true, authorityExpansion: ['requiredHostAccess'] });
    expect(evaluatePluginAuthorityReview({
      previous,
      candidate: widened,
      selectedOptionalAccess: [],
      readAccountSettings: () => ({ pluginUpdateReviewModeV1: 'confirmAccessChanges' }),
    })).toMatchObject({ requiresReview: true, authorityExpansion: ['requiredHostAccess'] });
  });

  it('applies a reach expansion without review in auto-apply mode', () => {
    expect(evaluatePluginAuthorityReview({
      previous,
      candidate: widened,
      selectedOptionalAccess: [],
      readAccountSettings: () => ({ pluginUpdateReviewModeV1: 'autoApply' }),
    })).toEqual({ requiresReview: false, authorityExpansion: [], preservedOptionalAccess: [] });
  });

  it('keeps each still-valid optional grant and drops only the widened one in auto-apply mode', () => {
    expect(evaluatePluginAuthorityReview({
      previous: sessionsOptionalManifest(['read']),
      candidate: sessionsOptionalManifest(['read', 'write']),
      selectedOptionalAccess: [sessionsSelection(['read'])],
      readAccountSettings: () => ({ pluginUpdateReviewModeV1: 'autoApply' }),
    })).toEqual({ requiresReview: false, authorityExpansion: [], preservedOptionalAccess: [] });
    expect(evaluatePluginAuthorityReview({
      previous: sessionsOptionalManifest(['read', 'write']),
      candidate: sessionsOptionalManifest(['read']),
      selectedOptionalAccess: [sessionsSelection(['read', 'write'])],
      readAccountSettings: () => ({ pluginUpdateReviewModeV1: 'autoApply' }),
    })).toMatchObject({ requiresReview: false, preservedOptionalAccess: [sessionsSelection(['read'])] });
  });

});
