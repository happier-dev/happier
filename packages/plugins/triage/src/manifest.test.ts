import { readFileSync } from 'node:fs';

import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
  PLUGIN_MANIFEST,
  TRIAGE_PLUGIN,
  TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
} from './manifest.js';
import { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1 } from './actions/listEntriesProtocol.js';
import { TRIAGE_ENTRIES_CONTROL_LOCAL_ID_V1 } from './composer/attachmentValue.js';
import { TRIAGE_LIST_PAGE_RENDERER_ID_V1 } from './ui/contributions.js';
import { TRIAGE_UI_TRANSLATIONS } from './ui/translations.js';

describe('Triage plugin manifest', () => {
  it('projects its prior cold identity and declared contribution families through one definePlugin value', () => {
    const normalized = parsePluginManifest(TRIAGE_PLUGIN.manifest);

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) throw new Error('Expected the Triage definePlugin manifest to normalize');
    expect(TRIAGE_PLUGIN.manifest).toBe(PLUGIN_MANIFEST);
    expect({
      id: normalized.manifest.id,
      version: normalized.manifest.version,
      displayName: normalized.manifest.displayName,
      entrypoints: normalized.manifest.entrypoints,
    }).toEqual({
      id: 'happier.triage',
      version: '0.0.0',
      displayName: 'PRs & Issues',
      entrypoints: { daemon: './.happier-plugin/daemon.js' },
    });
    expect(Object.keys(TRIAGE_PLUGIN.manifest.contributes).sort()).toEqual([
      'accountCollections',
      'actions',
      'composerAttachments',
      'composerControls',
      'pluginContributionPoints',
      'ui',
    ]);
  });

  it('keeps Protocol test-only because production uses public SDK and feature protocol owners', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Readonly<{
      dependencies?: Readonly<Record<string, string>>;
      devDependencies?: Readonly<Record<string, string>>;
    }>;

    expect(packageJson.dependencies?.['@happier-dev/protocol']).toBeUndefined();
    expect(packageJson.devDependencies?.['@happier-dev/protocol']).toBe('0.0.0');
  });

  it('is admitted by the canonical public manifest parser', () => {
    const parsed = parsePluginManifest(PLUGIN_MANIFEST);
    expect(parsed.ok ? null : parsed.diagnostics).toBe(null);
  });

  it('puts every durable local mutation behind host-owned confirmation', () => {
    const nonSafeActions = PLUGIN_MANIFEST.contributes.actions
      .filter((action) => action.dangerLevel !== 'safe');

    expect(nonSafeActions).toHaveLength(7);
    for (const action of nonSafeActions) {
      expect(action.confirmation, action.id).toMatchObject({
        title: expect.anything(),
        body: expect.anything(),
        confirmLabel: expect.anything(),
      });
    }
  });

  it('keeps mounted UI Actions out of global placement discovery', () => {
    const uiActions = PLUGIN_MANIFEST.contributes.actions
      .filter((action) => action.surfaces.includes('ui'));

    expect(uiActions.length).toBeGreaterThan(0);
    // The explicit empty list is the canonical mounted-only declaration: the
    // definePlugin projection preserves it on the wire, and the host admits it
    // while global placement discovery reads no destination from it.
    for (const action of uiActions) {
      expect(action, action.id).toMatchObject({ placementBindings: [] });
    }
  });

  it('declares the persisted identity that source contributions target', () => {
    // The plugin id is the persisted connected-account, contribution and
    // Collection-row key, so it is asserted as an exact literal rather than
    // read back from the manifest. It must also equal the protocol-published
    // target id: a mismatch aims every source contribution at no plugin.
    expect(PLUGIN_MANIFEST.id).toBe('happier.triage');
    expect(PLUGIN_MANIFEST.id).toBe(TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1);
  });

  it('declares the one target-owned V1 source contribution point', () => {
    const expectedPoint = {
      id: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
      maxContributionsPerContributor: 1,
      protocols: [{
        id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
        version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
      }],
    };

    expect(PLUGIN_MANIFEST.contributes?.pluginContributionPoints).toHaveLength(1);
    expect(PLUGIN_MANIFEST.contributes?.pluginContributionPoints?.[0]).toMatchObject(expectedPoint);
    // The public target reference may also carry the Protocol-owned semantic
    // decoder. This assertion owns only the stable routing identity.
    expect(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1).toMatchObject({
      targetPluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
      id: expectedPoint.id,
      protocol: expectedPoint.protocols[0],
    });
  });

  it('offers the entries control only in the scopes that can carry an attachment', () => {
    // `core/COMPOSER.md` §1 fixes the set. The host reads an ABSENT `scopes` as
    // EVERY scope (`pluginContributedActionComposerChips.tsx`
    // `qualifiesForComposerScope`), so leaving it undeclared is not "no policy
    // yet" — it is the widest possible one. `automationAuthoring` has no
    // Message-attachment capability at all, so the control would open a picker
    // whose attachment nothing could ever hold; `participantMessage` has no
    // approved V1 journey.
    const control = PLUGIN_MANIFEST.contributes.composerControls?.find(
      (candidate) => candidate.id === TRIAGE_ENTRIES_CONTROL_LOCAL_ID_V1,
    );

    expect(control?.scopes).toEqual(['session', 'newSession', 'pendingMessage']);
  });

  it('names the product, not the program, everywhere a user can read it', () => {
    expect(PLUGIN_MANIFEST.displayName).toBe('PRs & Issues');
    expect(`${PLUGIN_MANIFEST.displayName} ${PLUGIN_MANIFEST.description}`).not.toMatch(/triage/iu);
  });

  it('carries the daemon entrypoint the bundled activation source resolves', () => {
    // The canonical packager (`scripts/migrations/extensions/generateBundledPluginEntries.ts`)
    // emits the daemon runtime at `.happier-plugin/daemon.js` and the release
    // contract pins that exact path
    // (`scripts/release/publish_cli_binaries_native_matrix.contract.test.mjs`).
    // `./dist/index.js` is the retired pre-packager entry: it is this package's
    // `main` for in-repo importers, not the path the host loads.
    expect(PLUGIN_MANIFEST.entrypoints.daemon).toBe('./.happier-plugin/daemon.js');
  });

  it('offers one existing safe list read to Voice through its canonical daemon Action', () => {
    const action = PLUGIN_MANIFEST.contributes.actions.find(
      (candidate) => candidate.id === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
    );

    // This is deliberately a pre-existing bounded list read, not a new GitHub
    // mutation. The Action declaration has one daemon implementation and adds
    // Voice only as an invocation surface; no Triage-specific Voice handler or
    // router is involved.
    expect(action).toMatchObject({
      id: TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
      surfaces: ['ui', 'voice'],
      execution: { target: 'daemon' },
    });
    expect(PLUGIN_MANIFEST.contributes.actions
      .filter((candidate) => candidate.id !== TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1)
      .some((candidate) => candidate.surfaces.includes('voice'))).toBe(false);
  });

  it('declares localized Voice Action presentation in every shipped Triage bundle', () => {
    const action = PLUGIN_MANIFEST.contributes.actions.find(
      (candidate) => candidate.id === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
    );

    expect(action).toMatchObject({
      title: {
        key: 'plugins.triage.action.listEntries.title',
        fallback: 'Read the current list window',
      },
      description: {
        key: 'plugins.triage.action.listEntries.description',
        fallback: 'Reads one bounded ordered window of pull requests, issues and error groups from the configured sources.',
      },
    });
    for (const messages of Object.values(TRIAGE_UI_TRANSLATIONS)) {
      expect(messages['plugins.triage.action.listEntries.title']).toEqual(expect.any(String));
      expect(messages['plugins.triage.action.listEntries.description']).toEqual(expect.any(String));
    }
  });

  it('requires current-context publication only for the list-page renderer', () => {
    const renderers = PLUGIN_MANIFEST.contributes.ui?.renderers ?? [];
    const listPage = renderers.find((candidate) => candidate.id === TRIAGE_LIST_PAGE_RENDERER_ID_V1);

    expect(listPage?.requiredHostMethods).toEqual([
      'executeAction',
      'publishCurrentUiContext',
    ]);
    expect(renderers
      .filter((candidate) => candidate.id !== TRIAGE_LIST_PAGE_RENDERER_ID_V1)
      .some((candidate) => candidate.requiredHostMethods?.includes('publishCurrentUiContext')))
      .toBe(false);
  });
});
