import axios from 'axios';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountSettingsV2UpdateRequestSchema, accountSettingsParse, type AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { createCliSettingsDeclarationAction } from './settingsDeclarationAction';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { SettingsDeclarationActionOutputSchemasV1, type SettingsDeclarationDescriptorV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { createCliSettingsCatalogServices } from './settingsCatalogServices';
import { createSignedInSummaryCatalogFixture } from './settingsCatalog.test-support';
import { emptyConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
type UiResetHost = Readonly<{
  settingsDeclarationAction: NonNullable<ActionExecutorDeps['settingsDeclarationAction']>;
  readSettings(): Readonly<Record<string, unknown>>;
  readStoredSettings(): Readonly<Record<string, unknown>>;
  sourceControlAnchors: readonly string[];
  changeUnrelatedSetting(): void;
}>;
type UiResetHarnessModule = Readonly<{
  createSettingsResetParityHost(params: Readonly<{
    initial: Readonly<Record<string, unknown>>;
    mutationSnapshot: Readonly<Record<string, unknown>>;
    mutationServices?: Pick<ReturnType<typeof createCliSettingsCatalogServices>, 'readScmDiffSummaryCatalog'>;
    accountScope?: { serverId: string; accountId: string };
  }>): UiResetHost;
}>;
// Runtime import follows the existing cross-Voice convention: UI aliases/globals stay out of CLI compilation.
const uiSetupPath = new URL('../../../../ui/sources/dev/vitestSetup.ts', import.meta.url).href;
await import(uiSetupPath);
const uiHarnessPath = new URL('../../../../ui/sources/dev/testkit/harness/settingsResetParityHarness.ts', import.meta.url).href;
const uiHarness: UiResetHarnessModule = await import(uiHarnessPath);

function executor(settingsDeclarationAction: NonNullable<ActionExecutorDeps['settingsDeclarationAction']>) {
  // Unrelated outward ports must stay unused; the public Action admission remains real.
  const unused = async () => { throw new Error('unexpected_unrelated_transport'); };
  return createActionExecutor({ settingsDeclarationAction,
    executionRunStart: unused, executionRunList: unused, executionRunGet: unused,
    detachedExecutionRunSend: unused, executionRunStop: unused, executionRunAction: unused,
    executionRunWait: unused, sessionOpen: unused, sessionFork: unused, sessionRollback: unused,
    sessionSpawnNew: unused, pathsListRecent: unused, machinesList: unused, serversList: unused,
    reviewEnginesList: unused, agentsBackendsList: unused, agentsModelsList: unused,
    sessionSendMessage: unused, sessionModeSet: unused, sessionModesList: unused, sessionList: unused,
    sessionActivityGet: unused, sessionRecentMessagesGet: unused, resetGlobalVoiceAgent: unused,
    daemonMemorySearch: unused, daemonMemoryGetWindow: unused, daemonMemoryEnsureUpToDate: unused,
  });
}

afterEach(() => { vi.restoreAllMocks(); resetInMemoryAccountSettingsContextForTests(); });

describe('public Settings reset parity', () => {
  it('resets raw Account presence on App without a receipt while preserving unrelated changes', async () => {
    const initial = { favoriteMachines: ['neighbor'], 'scm.diffSummary.enabled': true };
    const host = uiHarness.createSettingsResetParityHost({ initial, mutationSnapshot: initial,
      accountScope: { serverId: 'parity-home', accountId: 'parity-account' } });
    host.changeUnrelatedSetting();
    const app = executor(host.settingsDeclarationAction);
    const anchor = 'sourceControl.explainChanges';
    const context = { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: 'settings.reset' } } as const;
    const result = await app.execute('settings.reset', { anchor, expected: { value: true } }, context);
    expect(result).toEqual({ ok: true, result: { anchor, value: true } });
    if (result.ok) SettingsDeclarationActionOutputSchemasV1['settings.reset'].parse(result.result);
    expect(host.readStoredSettings()).toEqual({ favoriteMachines: ['unrelated'] });
    expect(await app.execute('settings.reset', { anchor, expected: { value: true } }, context))
      .toEqual(result);
    expect(host.readStoredSettings()).toEqual({ favoriteMachines: ['unrelated'] });
    expect(await app.execute('settings.reset', { anchor, expected: { value: false } }, context))
      .toMatchObject({ ok: false, errorCode: 'account_settings_mutation_conflict' });
    expect(host.readStoredSettings()).toEqual({ favoriteMachines: ['unrelated'] });
  });
  const values = {
    explainChanges: false, summaryModel: null as Record<string, unknown> | null, outputLanguage: 'fr', prepareAfterTurn: true,
    reviewQualityAggregation: 'median',
    aiSuggestionsEnabled: true, aiSuggestionsProvider: 'pc_local', aiSuggestionsModel: 'suggestions-model',
    aiSuggestionsNextEdit: true, aiSuggestionsNextEditModel: 'next-edit-model', aiSuggestionsMode: 'onRequest',
    aiSuggestionsDelay: 'relaxed', aiSuggestionsExcluded: ['private/**'], aiSuggestionsDisabledLanguages: ['markdown'],
    investigateSurroundingFiles: true, commitStrategy: 'git_staging', commitMessageGenerator: false,
    commitMessageAgent: { v: 1, modelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'default' }, permissionMode: 'no_tools' } as Record<string, unknown>, commitMessageInstructions: 'Use a concise subject.', includeCoAuthoredBy: false,
    confirmBeforePulling: false, confirmBeforePushing: false, pushRejection: 'manual', pullRequestPlacement: 'details', resourceOpenLocation: 'github',
    diffRenderer: 'happier', diffLayout: 'split', syntaxHighlighting: 'advanced', changedFilesDensity: 'compact',
    gitPaneLayout: 'tabs', changedFilesLayout: 'tree', showLineNumbersInDiffs: false,
    showLineNumbersInToolViews: true, wrapLinesInDiffs: true, editorAutoSave: true, markdownEditMode: 'raw',
    editorFormatOnSave: true, editorInlayHints: 'all', editorSemanticHighlighting: false,
    askWithoutSessionTarget: 'session',
    gitRouting: 'happier.scm.backend.sapling/sapling',
    backendDefaultDiff: { backendId: 'happier.scm.backend.git/git', mode: 'pending' },
  };
  const services = createCliSettingsCatalogServices({});
  let admitted: Awaited<ReturnType<typeof createSignedInSummaryCatalogFixture>> | undefined;
  beforeAll(async () => {
    admitted = await createSignedInSummaryCatalogFixture();
    const catalog = await services.readScmDiffSummaryCatalog!(accountSettingsParse({}), '');
    const model = catalog?.profiles.find(profile => profile.costTier === 'low' && profile.structuredOutput === 'supported');
    if (!model?.modelSelector) throw new Error('Admitted Agent must produce a supported low-cost model selector');
    const selector = model.modelSelector;
    values.summaryModel = { v: 1,
      modelSelection: selector.modelSelection ?? { agentTargetKey: selector.backendTargetKey, providerConnectionId: null, modelId: selector.modelId ?? 'default' },
      ...(selector.connectedServices !== undefined ? { connectedServices: selector.connectedServices } : {}),
      ...(selector.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: selector.sessionConfigOptionOverrides } : {}),
    };
  });
  afterAll(async () => { await admitted?.dispose(); vi.unstubAllEnvs(); });

  it('undoes the App Voice owner write using the acknowledged server-normalized transition', async () => {
    const baseline = { favoriteMachines: ['neighbor'] };
    const scope = { serverId: 'parity-home', accountId: 'parity-account' };
    const host = uiHarness.createSettingsResetParityHost({ initial: baseline, mutationSnapshot: baseline, accountScope: scope });
    const app = executor(host.settingsDeclarationAction);
    const anchor = 'voiceDictation.language';
    const context = { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: 'settings.set' } } as const;
    const capture = await app.execute('settings.set', { anchor, value: 'fr', reversal: { kind: 'capture' } }, context);
    expect(capture).toMatchObject({ ok: true, result: { value: 'fr', reversal: expect.any(Object) } });
    if (!capture.ok) throw new Error(JSON.stringify(capture));
    const { reversal } = SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(capture.result);
    if (!reversal) throw new Error('Missing App receipt');
    expect(host.readStoredSettings().voiceSettingsV1).toMatchObject({ dictation: { language: 'fr' } });
    expect(host.readStoredSettings()).not.toHaveProperty('voice');
    host.changeUnrelatedSetting();
    expect(await app.execute('settings.set', { anchor, value: 'fr', reversal: { kind: 'restore', ...reversal } }, context))
      .toMatchObject({ ok: true });
    expect(host.readStoredSettings()).toEqual({ favoriteMachines: ['unrelated'] });
  });

  it('covers the authored Source control catalog and keeps saved results at their Machine owner', async () => {
    const uiHost = uiHarness.createSettingsResetParityHost({ initial: {}, mutationSnapshot: {}, mutationServices: services });
    const anchorFor = (id: string) => id === 'askWithoutSessionTarget' ? `files.${id}` : `sourceControl.${id}`;
    expect([...Object.keys(values).map(anchorFor), 'sourceControl.savedWalkthroughs', 'sourceControl.aiSuggestionsUsage',
      'files.trackAgentEdits', 'files.imageBackground'].sort())
      .toEqual([...uiHost.sourceControlAnchors].sort());
    const cli = executor(createCliSettingsDeclarationAction({}));
    const authoredAnchors = new Set(uiHost.sourceControlAnchors);
    const catalogs: SettingsDeclarationDescriptorV1[][] = [];
    for (const [owner, surface] of [[cli, 'cli'], [executor(uiHost.settingsDeclarationAction), 'ui']] as const) {
      const list = await owner.execute('settings.list', { pageId: 'sourceControl' }, { surface });
      if (!list.ok) throw new Error(JSON.stringify(list));
      const listed = SettingsDeclarationActionOutputSchemasV1['settings.list'].parse(list.result);
      const authored = listed.items.filter(item => authoredAnchors.has(item.anchor));
      expect(authored.map(item => item.anchor).sort()).toEqual([...authoredAnchors].sort());
      catalogs.push(authored);
      expect(await owner.execute('settings.get', { anchor: 'sourceControl.savedWalkthroughs' }, { surface }))
        .toMatchObject({ ok: false, errorCode: 'setting_not_bound' });
      expect(await owner.execute('settings.get', { anchor: 'sourceControl.aiSuggestionsUsage' }, { surface }))
        .toMatchObject({ ok: false, errorCode: 'setting_not_bound' });
    }
    // CLI also exposes Account preferences used outside authored Settings rows.
    // Localized copy and availability belong to the answering host; structural declaration metadata agrees.
    const metadata = ({ readable: _readable, writable: _writable, unavailableReason: _unavailableReason,
      title: _title, description: _description, allowedValues: _allowedValues,
      ...declaration }: SettingsDeclarationDescriptorV1) => declaration;
    for (const item of catalogs[0]) {
      const appItem = catalogs[1].find(candidate => candidate.anchor === item.anchor);
      if (!appItem) throw new Error(`Missing authored App setting: ${item.anchor}`);
      expect(metadata(item), JSON.stringify({ cli: metadata(item), app: metadata(appItem) })).toEqual(metadata(appItem));
      if (item.readable && appItem.readable) expect(item.allowedValues, item.anchor).toEqual(appItem.allowedValues);
    }
  });

  const cases = (Object.keys(values) as (keyof typeof values)[]).map(id => ({ id, external: false }));
  cases.push({ id: 'gitRouting', external: true }, { id: 'backendDefaultDiff', external: true });
  it.each(cases)('round-trips $id (external: $external) through capture and restore on CLI and App', async ({ id, external }) => {
    const baseline = { favoriteMachines: ['neighbor'], scmDefaultDiffModeByBackend: { neighbor: 'both' } };
    let content: AccountSettingsStoredContentEnvelope = { t: 'plain', v: baseline };
    let version = 1;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: version,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (url.endsWith('/v1/account/entity-rows/connected-accounts/purposes')) return { status: 200, data: {
        status: 'present', revision: 1, content: { t: 'plain', v: emptyConnectedAccountCatalogRecordV1('purposes') },
      } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content, version } };
      throw new Error(`Unexpected HTTP read: ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      if (!url.endsWith('/v2/account/settings')) throw new Error(`Unexpected HTTP write: ${url}`);
      const request = AccountSettingsV2UpdateRequestSchema.parse(raw);
      expect(request.expectedVersion).toBe(version);
      if (!request.content) throw new Error('Expected stored settings');
      content = request.content;
      return { status: 200, data: { success: true, version: ++version } };
    });
    const scope = { serverId: 'parity-home', accountId: 'parity-account' };
    const token = `test.${Buffer.from(JSON.stringify({ sub: scope.accountId })).toString('base64url')}.test`;
    const cli = executor(createCliSettingsDeclarationAction({ credentials: { token, encryption: null }, serverId: scope.serverId }));
      const value = values[id];
      const anchor = id === 'askWithoutSessionTarget' ? `files.${id}` : `sourceControl.${id}`;
      const rawBefore = content.t === 'plain' ? content.v : {};
      const rowHost = uiHarness.createSettingsResetParityHost({ initial: rawBefore, mutationSnapshot: rawBefore,
        mutationServices: services });
      const rowUi = executor(rowHost.settingsDeclarationAction);
      const initial = await cli.execute('settings.get', { anchor }, { surface: 'cli' });
      expect(initial.ok, anchor).toBe(true);
      for (const [owner, surface] of [[cli, 'cli'], [rowUi, 'ui']] as const) {
        const context = { surface, authority: 'present_user', presentUserConfirmation: { actionId: 'settings.set' } } as const;
        const changed = await owner.execute('settings.set', { anchor, value }, context);
        expect(changed, `${surface} ${anchor}: ${JSON.stringify(changed)}`).toMatchObject({ ok: true, result: { anchor, value } });
        if (!changed.ok) throw new Error(JSON.stringify(changed));
        SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(changed.result);
        const read = await owner.execute('settings.get', { anchor, includeVersion: true }, { surface });
        const readValue = id === 'backendDefaultDiff' ? { neighbor: 'both', 'happier.scm.backend.git/git': 'pending' } : value;
        expect(read, anchor).toMatchObject({ ok: true, result: { anchor, value: readValue, settingsVersion: expect.any(Number) } });
        if (read.ok) SettingsDeclarationActionOutputSchemasV1['settings.get'].parse(read.result);
      }
      // Compare actual persistence deltas, excluding UI-only runtime defaults.
      expect(rowHost.readStoredSettings(), anchor).toEqual(content.t === 'plain' ? content.v : {});
      if (!initial.ok) throw new Error(JSON.stringify(initial));
      const resetResults = [];
      for (const [owner, surface] of [[cli, 'cli'], [rowUi, 'ui']] as const) {
        const reset = await owner.execute('settings.reset', { anchor }, { surface, authority: 'present_user',
          presentUserConfirmation: { actionId: 'settings.reset' } });
        resetResults.push(reset);
        if (reset.ok) {
          SettingsDeclarationActionOutputSchemasV1['settings.reset'].parse(reset.result);
          expect(reset).toMatchObject(initial);
        }
      }
      expect(resetResults[1], anchor).toEqual(resetResults[0]);

      // Exact receipts must survive unrelated Account writes, including sparse raw absence,
      // multi-key routing and object-valued backend maps, on either host.
      const baselineRaw = { ...baseline };
      content = { t: 'plain', v: baselineRaw };
      version += 1;
      const reversibleHost = uiHarness.createSettingsResetParityHost({ initial: baselineRaw, mutationSnapshot: baselineRaw,
        accountScope: scope, mutationServices: services });
      const reversibleValue = external && id === 'gitRouting' ? 'example.scm.community/custom'
        : external && id === 'backendDefaultDiff' ? { backendId: 'example.scm.community/custom', mode: 'pending' } : value;
      const captures = [];
      for (const [owner, surface] of [[cli, 'cli'], [executor(reversibleHost.settingsDeclarationAction), 'ui']] as const) {
        const context = { surface, authority: 'present_user', presentUserConfirmation: { actionId: 'settings.set' } } as const;
        const capture = await owner.execute('settings.set', { anchor, value: reversibleValue, reversal: { kind: 'capture' } }, context);
        expect(capture, `${surface} capture ${anchor}`).toMatchObject({ ok: true, result: { reversal: expect.any(Object) } });
        if (!capture.ok) throw new Error(JSON.stringify(capture));
        const result = SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(capture.result);
        if (!result.reversal) throw new Error(`Missing receipt: ${surface} ${anchor}`);
        if (surface === 'cli') { content = { t: 'plain', v: { ...(content.t === 'plain' ? content.v : {}), favoriteMachines: ['unrelated'] } }; version += 1; }
        else reversibleHost.changeUnrelatedSetting();
        captures.push({ owner, surface, receipt: result.reversal });
      }
      for (const { owner, surface } of captures) {
        // Each real producer's receipt is consumed by the other host, whose global version differs.
        const receipt = captures.find(capture => capture.surface !== surface)?.receipt;
        if (!receipt) throw new Error('Missing other host receipt');
        const context = { surface, authority: 'present_user', presentUserConfirmation: { actionId: 'settings.set' } } as const;
        const restored = await owner.execute('settings.set', { anchor, value: reversibleValue, reversal: { kind: 'restore', ...receipt } }, context);
        expect(restored, `${surface} restore ${anchor}`).toMatchObject({ ok: true });
        if (restored.ok) SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(restored.result);
        const persisted = surface === 'cli' ? content.t === 'plain' ? content.v : {} : reversibleHost.readStoredSettings();
        expect(persisted, `${surface} exact restoration ${anchor}`).toEqual({ ...baselineRaw, favoriteMachines: ['unrelated'] });
      }
  });

  it('resets the owner-bound Agent mode while preserving concurrent neighboring policy on both hosts', async () => {
    resetInMemoryAccountSettingsContextForTests();
    const baseline = { analyticsOptOut: true, actionsSettingsV1: { v: 1, actions: {
      'prompt_doc.update': { disabledSurfaces: ['agent'], approvalRequiredSurfaces: ['agent'] },
      'prompt_doc.create': { disabledSurfaces: ['mcp'] },
    } } };
    const concurrent = { analyticsOptOut: true, favoriteMachines: ['concurrent'], actionsSettingsV1: { ...baseline.actionsSettingsV1,
      actions: { ...baseline.actionsSettingsV1.actions,
        'prompt_doc.update': { disabledSurfaces: ['agent', 'cli'], approvalRequiredSurfaces: ['agent', 'mcp'] },
      },
    } };
    let content: AccountSettingsStoredContentEnvelope = { t: 'plain', v: baseline };
    let version = 1;
    // HTTP is the persistence boundary. CLI admission, schema validation and CAS retry remain real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content, version } };
      throw new Error(`Unexpected HTTP read: ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      if (!url.endsWith('/v2/account/settings')) throw new Error(`Unexpected HTTP write: ${url}`);
      const request = AccountSettingsV2UpdateRequestSchema.parse(raw);
      expect(request.expectedVersion).toBe(version);
      if (version === 1) {
        content = { t: 'plain', v: concurrent };
        version = 2;
        return { status: 200, data: { success: false, error: 'version-mismatch', currentVersion: version, currentContent: content } };
      }
      if (!request.content) throw new Error('Expected stored settings');
      content = request.content;
      version += 1;
      return { status: 200, data: { success: true, version } };
    });
    const anchor = 'actions.promptDocAgentEdits';
    const confirmation = { authority: 'present_user', presentUserConfirmation: { actionId: 'settings.reset' } } as const;
    const cli = executor(createCliSettingsDeclarationAction({ credentials: { token: 'reset-parity', encryption: null } }));
    const cliResult = await cli.execute('settings.reset', { anchor }, { ...confirmation, surface: 'cli' });
    expect(cliResult).toMatchObject({ ok: true, result: { anchor, value: 'default' } });
    const cliSettings = accountSettingsParse(content.t === 'plain' ? content.v : {});
    expect(cliSettings.actionsSettingsV1.actions['prompt_doc.update'])
      .toMatchObject({ disabledSurfaces: ['cli'], approvalRequiredSurfaces: ['mcp'] });
    expect(cliSettings.actionsSettingsV1.actions['prompt_doc.create'])
      .toEqual(accountSettingsParse(baseline).actionsSettingsV1.actions['prompt_doc.create']);
    expect(cliSettings.favoriteMachines).toEqual(['concurrent']);

    const uiHost = uiHarness.createSettingsResetParityHost({ initial: baseline, mutationSnapshot: concurrent });
    const ui = executor(uiHost.settingsDeclarationAction);
    expect(await ui.execute('settings.reset', { anchor }, { ...confirmation, surface: 'ui' })).toEqual(cliResult);
    const uiSettings = accountSettingsParse(uiHost.readSettings());
    expect(uiSettings.actionsSettingsV1).toEqual(cliSettings.actionsSettingsV1);
    expect(uiSettings.favoriteMachines).toEqual(['concurrent']);
    for (const [owner, surface] of [[cli, 'cli'], [ui, 'ui']] as const) {
      expect(await owner.execute('settings.get', { anchor }, { ...confirmation, surface }))
        .toMatchObject({ ok: true, result: { anchor, value: 'default' } });
      // Scalar inversion shares default admission; an unsupported reset must remain a refusal.
      expect(await owner.execute('settings.reset', { anchor: 'account.analytics' }, { ...confirmation, surface }))
        .toMatchObject({ ok: true, result: { anchor: 'account.analytics', value: true } });
      expect(await owner.execute('settings.reset', { anchor: 'machines.terminal.host' }, { ...confirmation, surface }))
        .toMatchObject({ ok: false, errorCode: 'setting_reset_unsupported' });
    }
    expect(content.t === 'plain' ? accountSettingsParse(content.v).analyticsOptOut : null).toBe(false);
    expect(accountSettingsParse(uiHost.readSettings()).analyticsOptOut).toBe(false);
  });
});
