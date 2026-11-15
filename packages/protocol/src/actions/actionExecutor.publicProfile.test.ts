import { describe, expect, it, vi } from 'vitest';
import { createBlockingApprovalCoordinator } from './blockingApprovalCoordinator.js';
import { projectNativeJsonValueForTransport } from '../json/strictJsonValue.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { bindHomeDomainActionHttpRequestV1, bindPublicProfilePreparedHttpRequestV1 } from './homeDomainActionFamily.js';
import { bindPublicProfileActionPorts, type PreparedPublicProfileAction, type PublicProfilePreviewAdmission } from './executor/publicProfileActions.js';
import { normalizeUsageQuery, type UsageQuery } from '../inputs/usageQuery.js';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PUBLIC_PROFILE_FIELDS_V1, PublicProfileSnapshotV1Schema } from '../account/publicProfile.js';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfileOwnerReadV1Schema, PublicProfileViewV1Schema, type PublicProfilePreparedAppearanceV1 } from '../account/publicProfilePublication.js';
import { PublicProfilePreviewResultV1Schema, PublicProfileUpdateResultV1Schema } from '../account/publicProfileIntents.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { buildPublicProfileSnapshot } from '../account/publicProfileSnapshot.js';
import { resolveUsagePageAggregation } from '../usage/resolveUsagePageAggregation.js';
import { UsageAnalyticsQueryResponseSchema } from '../usage/usageAnalyticsContracts.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { createWidgetDefinitionArtifactPortV1 } from '../widgets/widgetDefinitionArtifactV1.js';
import { WidgetDefinitionV1Schema } from '../widgets/widgetDefinitionV1.js';
import { WidgetAreaLayoutV1Schema } from '../widgets/widgetSurfaceArtifactV1.js';
import { ArtifactActionInputSchemasV1, ArtifactDocumentV1Schema } from '../artifacts/artifactActionsV1.js';
import { computeActionInputApprovalDigestV1 } from './decisionAuthority.js';

const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
  'account.public_profile.update': ['cli', 'plugin'], 'account.public_profile.refresh': ['cli'],
} });
const context = { surface: 'cli', authority: 'present_user', serverId: 'home', expectedAccountId: 'account',
  runtimeAccountId: 'account', actionRequestId: 'public-profile-request', actionsSettings: settings } as const;
const approvalRequired: NonNullable<ActionExecutorDeps['isActionApprovalRequired']> = (id, ctx, input) =>
  isApprovalRequiredByActionsSettings(id, ctx.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 }), ctx, undefined, undefined, input);
const layout = { v: 1, items: [] } as const;
const picturePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
function reviewedPictureAppearance(): PublicProfilePreparedAppearanceV1 {
  return { atmosphere: { source: 'picture', picture: { layout: 'horizon', descriptor: {
    kind: 'photo', title: 'Reviewed image', credit: null, adaptiveHaze: false, horizon: {}, focus: {},
    hour: 0, grades: { light: 0, dusk: 0, night: 0 }, dark: 'night',
    look: { effect: 'mosaic', params: {}, strength: 0.37, dissolve: { style: 'rows', from: 0.58, to: 1 } },
  }, content: { mimeType: 'image/png', base64: picturePng } } }, theme: 'light' };
}
function owner() {
  return PublicProfileOwnerReadV1Schema.parse({ kind: 'ready', context: { handle: 'ada', identity: { name: 'Ada' },
    service: { displayName: 'Home', publicBaseUrl: 'https://home.test' }, urls: {
      page: 'https://home.test/@ada', json: 'https://home.test/@ada/json', badgeBase: 'https://home.test/@ada/badge',
      card: 'https://home.test/@ada/card.svg', og: 'https://home.test/@ada/og.png', report: 'mailto:operator@home.test',
    } }, record: { state: 'published', policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, projectSelections: [],
    query: normalizeUsageQuery({ period: { relative: '90days' } }), snapshot: null, layout,
    appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, updatedAtMs: 1, publishedAtMs: 1, restriction: null,
  } });
}

describe('public-profile Actions through the shared executor', () => {
  it.each([
    { actionId: 'account.public_profile.preview', includePublic: true },
    { actionId: 'account.public_profile.update', includePublic: true },
    { actionId: 'account.public_profile.publish', includePublic: true },
    { actionId: 'account.public_profile.preview', includePublic: false },
  ] as const)('omits known-private selections and reports their count through $actionId (public=$includePublic)', async ({ actionId, includePublic }) => {
    const project = (name: string) => ({
      provider: { id: 'example/forge', kind: 'custom' as const, displayName: 'Forge', baseUrl: 'https://forge.test' },
      repository: { nameWithOwner: `owner/${name}` }, protocol: 'https' as const,
    });
    const publicProject = project('public');
    const privateProject = project('private');
    const policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields } };
    for (const field of PUBLIC_PROFILE_FIELDS_V1) policy.fields[field] = field === 'projects';
    const current = owner();
    if (current.kind !== 'ready') throw new Error('Expected existing edition');
    current.record.policy = policy;
    const writes: unknown[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      if (args.actionId === 'account.public_profile.get') return current;
      writes.push(bindPublicProfilePreparedHttpRequestV1(args.actionId, args.preparedRequest));
      return { kind: 'updated', record: null };
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {},
        getRepository: async selector => selector.repository.nameWithOwner === publicProject.repository.nameWithOwner
          ? { success: true, kind: 'public', repository: { label: 'owner/public', url: 'https://forge.test/owner/public' } }
          : { success: true, kind: 'private' },
      }),
    } as ActionExecutorDeps);
    const result = await executor.execute(actionId, {
      ...(actionId === 'account.public_profile.publish' ? { intent: 'publish' } : {}),
      policy, metadataSelection: { projectSelections: [privateProject, includePublic ? publicProject : project('another-private')] },
      query: normalizeUsageQuery({ period: { relative: 'all' } }), layout,
      appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
    }, { ...context, surface: 'ui', actionCaller: { kind: 'host' }, reviewPublicProfilePreparedAction: async () => true });
    const omittedPrivateProjectCount = includePublic ? 1 : 2;
    expect(result).toMatchObject({ ok: true, result: { omittedPrivateProjectCount } });
    if (!result.ok) throw new Error('Expected prepared result');
    expect(getActionSpec(actionId).outputSchema.parse(result.result)).toMatchObject({ omittedPrivateProjectCount });
    if (actionId === 'account.public_profile.preview') {
      expect(result).toMatchObject({ result: { kind: 'ready', view: { metadata: {
        projects: includePublic ? [{ label: 'owner/public', url: 'https://forge.test/owner/public' }] : [],
      } } } });
      expect(writes).toEqual([]);
    } else {
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ body: { projectSelections: [publicProject], metadata: {
        projects: [{ label: 'owner/public', url: 'https://forge.test/owner/public' }],
      } } });
      expect(JSON.stringify(writes)).not.toContain('owner/private');
      expect(JSON.stringify(writes)).not.toContain('omittedPrivateProjectCount');
    }
  });
  it.each(['unknown', 'unsupported'] as const)('still refuses a %s repository classification', async kind => {
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async () => owner();
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {},
        getRepository: async () => ({ success: true, kind }),
      }),
    } as ActionExecutorDeps);
    const result = await executor.execute('account.public_profile.preview', {
      policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, projects: true } },
      metadataSelection: { projectSelections: [{
        provider: { id: 'example/forge', kind: 'custom', displayName: 'Forge', baseUrl: 'https://forge.test' },
        repository: { nameWithOwner: 'owner/repository' }, protocol: 'https',
      }] }, query: normalizeUsageQuery({ period: { relative: 'all' } }), layout,
      appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
    }, context);
    expect(result).toMatchObject({ ok: true, result: { kind: 'unavailable', reason: 'project_visibility_unavailable' } });
  });
  it.each(['account.public_profile.preview', 'account.public_profile.update', 'account.public_profile.publish'] as const)(
    'retains the repository authentication cause when %s metadata cannot be prepared', async actionId => {
    const failureCause = { phase: 'scm.repository.read', errorClass: 'Error', errorCode: 'authentication_required',
      httpStatus: null };
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async () => owner();
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {},
        getRepository: async () => ({ success: false, kind: 'failed', code: 'repository_unavailable', failureCause }),
      }),
    } as ActionExecutorDeps);
    const result = await executor.execute(actionId, {
      ...(actionId === 'account.public_profile.publish' ? { intent: 'publish' } : {}),
      policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, projects: true } }, metadataSelection: { projectSelections: [{
        provider: { id: 'example/forge', kind: 'custom', displayName: 'Forge', baseUrl: 'https://forge.test' },
        repository: { nameWithOwner: 'owner/repository' }, protocol: 'https',
      }] }, query: normalizeUsageQuery({ period: { relative: 'all' } }), layout,
      appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
    }, context);
    expect(result).toMatchObject({ ok: false, failureCause });
  });
  it('prepares metadata-only All with the incumbent bounded artifact period and no Usage read', async () => {
    const current = owner();
    const policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields } };
    for (const field of PUBLIC_PROFILE_FIELDS_V1) policy.fields[field] = field === 'name';
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      if (args.actionId === 'account.public_profile.get') return current;
      throw new Error('Preview cannot mutate Home');
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
    } as ActionExecutorDeps);
    const result = await executor.execute('account.public_profile.preview', { policy, metadataSelection: {},
      query: normalizeUsageQuery({ period: { relative: 'all' } }), layout, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 }, context);
    expect(result).toMatchObject({ ok: true, result: { kind: 'ready', view: { snapshot: { period: { startMs: 0,
      endMs: expect.any(Number) }, facts: {} } } } });
  });
  it.each([
    { fields: ['tokens'], session: false, work: false, activity: false },
    { fields: ['calendar'], session: false, work: false, activity: true },
    { fields: ['agentTime'], session: true, work: false, activity: false },
    { fields: ['mergedPrs'], session: false, work: true, activity: false },
  ])('carries a widened $fields snapshot in one Update with only selected Usage demand', async scenario => {
    const current = owner();
    if (current.kind !== 'ready') throw new Error('Expected existing edition');
    current.record.policy = { indexable: false, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields } };
    for (const field of PUBLIC_PROFILE_FIELDS_V1) current.record.policy.fields[field] = false;
    current.record.query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1_000 } });
    const policy = structuredClone(current.record.policy);
    for (const field of PUBLIC_PROFILE_FIELDS_V1) policy.fields[field] = scenario.fields.includes(field);
    const writes: unknown[] = [];
    const queries: UsageQuery[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      if (args.actionId === 'account.public_profile.get') return current;
      writes.push(bindPublicProfilePreparedHttpRequestV1(args.actionId, args.preparedRequest));
      return { kind: 'updated', record: current.record };
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {}, buildSnapshot: buildPublicProfileSnapshot,
        usage: { query: async request => {
          queries.push(...request.queries);
          return resolveUsagePageAggregation({ queries: request.queries, accounting: request.queries.map(query => ({ query,
            status: 'available', asOfMs: 1_000, value: UsageAnalyticsQueryResponseSchema.parse({ v: 1,
              totals: { eventCount: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }, contributions: [],
              coverage: { status: 'complete', reasons: [], missingDimensions: [], ranked: [],
                range: { startMs: 0, endMs: 1_000, complete: true }, sources: [] },
            }),
          })) });
        } },
      }),
    } as ActionExecutorDeps);
    expect(await executor.execute('account.public_profile.update', { policy }, context)).toMatchObject({ ok: true });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ population: 'public_eligible_personal', includeAccounting: true, includeComparison: false,
      includeSessionEvidence: scenario.session, includeWorkEvidence: scenario.work, includeActivity: scenario.activity,
      includeQuotaHistory: false, includeTranscriptEvidence: false });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: '/v1/account/public-profile/policy', body: { policy, snapshot: { v: 1, facts: {} } } });
  });
  it.each(['ui', 'cli', 'agent', 'mcp', 'plugin'] as const)('allows facts-only Refresh by default on %s while respecting explicit Ask', surface => {
    const defaults = ActionsSettingsV1Schema.parse({ v: 1 });
    const ctx = { surface, authority: 'account_automation' as const };
    expect(isApprovalRequiredByActionsSettings('account.public_profile.refresh', defaults, ctx)).toBe(false);
    expect(isApprovalRequiredByActionsSettings('account.public_profile.refresh', ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'account.public_profile.refresh': { approvalRequiredSurfaces: [surface] } } }), ctx)).toBe(true);
  });
  it('resumes directly for a present UI user while agents still ask', () => {
    const defaults = ActionsSettingsV1Schema.parse({ v: 1 });
    expect(isApprovalRequiredByActionsSettings('account.public_profile.resume', defaults,
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } })).toBe(false);
    expect(isApprovalRequiredByActionsSettings('account.public_profile.resume', defaults,
      { surface: 'agent', authority: 'account_automation' })).toBe(true);
  });
  it('admits one captured operation once and finishes its Update without a child Refresh', async () => {
    let admissions = 0;
    const writes: unknown[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      if (args.actionId === 'account.public_profile.get') return owner();
      writes.push(args.preparedRequest);
      return { kind: 'updated', record: null };
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => { admissions += 1; } }),
    } as ActionExecutorDeps);
    const result = await executor.execute('account.public_profile.update', { policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1 }, context);
    expect(admissions).toBe(1);
    expect(result).toEqual({ ok: true, result: { kind: 'updated', record: null } });
    expect(writes).toEqual([{ operation: 'update', body: { policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1 } }]);
  });
  it('keeps an unchanged query and wider identity fields independent of Usage availability', async () => {
    const current = owner();
    if (current.kind !== 'ready' || !current.record.policy || !current.record.query) throw new Error('Expected existing edition');
    current.record.policy = { ...current.record.policy, fields: { ...current.record.policy.fields, name: false } };
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args =>
      args.actionId === 'account.public_profile.get' ? current : { kind: 'updated', record: current.record };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {},
        usage: { query: async () => { throw new Error('No selected Usage change'); } } }),
    } as ActionExecutorDeps);
    expect(await executor.execute('account.public_profile.update', { query: current.record.query,
      policy: { ...current.record.policy, fields: { ...current.record.policy.fields, name: true } } }, context))
      .toMatchObject({ ok: true, result: { kind: 'updated' } });
  });
  it.each(['ui', 'cli', 'agent'] as const)('compiles a private widget selection at Action preparation from %s without Usage', async surface => {
    const requests: unknown[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      if (args.actionId === 'account.public_profile.get') return owner();
      requests.push(args.preparedRequest);
      return { kind: 'updated', record: null };
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      widgetAccountScope: () => ({ serverId: 'home', accountId: 'account' }),
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
    } as ActionExecutorDeps);
    const selection = WidgetAreaLayoutV1Schema.parse({ v: 1, surface: { serverId: 'home', accountId: 'account',
      owner: { kind: 'corePage', pageId: 'public-profile', area: 'main', layoutId: 'minimal' } }, items: [{
      kind: 'widget', size: 'wide', frameStyle: 'plain', instance: { v: 1, id: 'chosen-totals', displayName: 'My totals',
        definition: { kind: 'builtin', id: 'usage_period_summary' }, bindings: {} },
    }] });
    await expect(executor.execute('account.public_profile.update', { layout: selection }, { ...context, surface,
      ...(surface === 'ui' ? { actionCaller: { kind: 'host' as const } } : {}),
      ...(surface === 'agent' ? { authority: 'account_automation' as const, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
        approvalWaivedSurfaces: { 'account.public_profile.update': ['agent'] } }) } : {}),
    })).resolves.toMatchObject({ ok: true, result: { kind: 'updated' } });
    expect(requests).toEqual([{ operation: 'update', body: { layout: { v: 1, items: [{ kind: 'widget', id: 'chosen-totals',
      size: 'wide', frameStyle: 'plain', title: 'My totals', presentation: { kind: 'usage', widgetId: 'usage_period_summary', inputs: {} },
    }] } } }]);
    await expect(executor.execute('account.public_profile.update', { layout: { ...selection,
      surface: { ...selection.surface, accountId: 'another-account' } } }, { ...context, surface }))
      .resolves.toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    expect(requests).toHaveLength(1);
  });
  it('retains the exact compiled Artifact copy across review and refuses its later unavailable declaration', async () => {
    const boundary = createWorkBoardArtifactBoundary();
    const definitions = createWidgetDefinitionArtifactPortV1({ ...boundary.transport,
      read: async (id, options) => {
        const row = await boundary.transport.read(id, options);
        return row ? { ...row, ownerAccountId: 'account' } : null;
      },
    }, { accountId: 'account' });
    await definitions.create(WidgetDefinitionV1Schema.parse({ v: 1, id: 'shared-days', name: 'Days',
      sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] },
      inputSchema: { type: 'object', additionalProperties: false },
      publicPresentation: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Active days',
        data: { kind: 'value', value: { kind: 'public_profile' } }, value: { path: ['snapshot', 'facts', 'activeDays'], type: 'number' } } } },
      body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'PRIVATE-BODY' } } },
      provenance: { source: { kind: 'authored' } },
    }));
    const writes: unknown[] = [];
    let artifactOwnerAccountId = 'account';
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      if (args.actionId === 'account.public_profile.get') return owner();
      writes.push(args.preparedRequest);
      return { kind: 'updated', record: null };
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      widgetAccountScope: () => ({ serverId: 'home', accountId: 'account' }),
      artifactAction: async args => {
        expect(args.actionId).toBe('artifact.get');
        expect('readOnly' in args && args.readOnly).toBe(true);
        const input = ArtifactActionInputSchemasV1['artifact.get'].parse(args.input);
        const row = await boundary.transport.read(input.artifactId, { signal: args.signal });
        return { artifact: row ? ArtifactDocumentV1Schema.parse({ artifactId: row.artifactId, header: row.header,
          body: row.body, revision: row.revision, ownerAccountId: artifactOwnerAccountId, access: 'owner',
          seq: 0, createdAt: 0, updatedAt: 0 }) : null };
      },
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
    } as ActionExecutorDeps);
    const selection = WidgetAreaLayoutV1Schema.parse({ v: 1, surface: { serverId: 'home', accountId: 'account',
      owner: { kind: 'corePage', pageId: 'public-profile', area: 'main' } }, items: [{ kind: 'widget',
      instance: { v: 1, id: 'days', definition: { kind: 'artifact', artifactId: 'shared-days' }, bindings: {} },
    }] });
    await expect(executor.execute('account.public_profile.update', { layout: selection }, { ...context,
      reviewPublicProfilePreparedAction: async () => { await definitions.update('shared-days', { publicPresentation: null }); return true; },
    })).resolves.toMatchObject({ ok: true });
    expect(writes).toMatchObject([{ operation: 'update', body: { layout: { items: [{ id: 'days', title: 'Days',
      presentation: { kind: 'declarative', document: { root: { label: 'Active days' } } },
    }] } } }]);
    expect(JSON.stringify(writes)).not.toContain('PRIVATE-BODY');
    artifactOwnerAccountId = 'another-account';
    await expect(executor.execute('account.public_profile.update', { layout: selection }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'widget_definition_account_mismatch' });
    expect(writes).toHaveLength(1);
    artifactOwnerAccountId = 'account';
    await expect(executor.execute('account.public_profile.update', { layout: selection }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'widget_public_presentation_unavailable' });
    expect(writes).toHaveLength(1);
  });
  it('compiles installed selections from exact metadata without listing saved placements or Account definitions', async () => {
    let metadataReads = 0;
    let unrelatedReads = 0;
    const requests: unknown[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      if (args.actionId === 'account.public_profile.get') return owner();
      requests.push(args.preparedRequest);
      return { kind: 'updated', record: null };
    };
    const identity = { pluginId: 'example.metrics', localId: 'days' };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      widgetAccountScope: () => ({ serverId: 'home', accountId: 'account' }),
      widgetCatalog: {
        list: async () => { unrelatedReads += 1; return []; },
        readInstalledDescriptor: async () => {
          metadataReads += 1;
          return { title: 'Shared days', availability: 'unavailable', sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
            publicPresentation: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Active days',
              data: { kind: 'value', value: { kind: 'public_profile' } }, value: { path: ['snapshot', 'facts', 'activeDays'], type: 'number' } } } } };
        },
      },
      artifactAction: async () => { unrelatedReads += 1; return { artifact: null }; },
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
    } as ActionExecutorDeps);
    const selection = WidgetAreaLayoutV1Schema.parse({ v: 1, surface: { serverId: 'home', accountId: 'account',
      owner: { kind: 'corePage', pageId: 'public-profile', area: 'main' } }, items: ['first', 'second'].map(id => ({ kind: 'widget',
      instance: { v: 1, id, definition: { kind: 'installed', surface: identity }, bindings: {} },
    })) });
    await expect(executor.execute('account.public_profile.update', { layout: selection }, context)).resolves.toMatchObject({ ok: true });
    expect(requests).toMatchObject([{ operation: 'update', body: { layout: { items: [
      { id: 'first', title: 'Shared days', presentation: { kind: 'declarative' } },
      { id: 'second', title: 'Shared days', presentation: { kind: 'declarative' } },
    ] } } }]);
    expect(metadataReads).toBe(1);
    expect(unrelatedReads).toBe(0);
  });
  it('keeps a private layout selection out of durable Action observations', () => {
    const selection = WidgetAreaLayoutV1Schema.parse({ v: 1,
      surface: { serverId: 'home', accountId: 'account', owner: { kind: 'corePage', pageId: 'public-profile', area: 'main' } },
      items: [{ kind: 'widget', instance: { v: 1, id: 'private', definition: { kind: 'inline', definition: {
        v: 1, id: 'private-definition', name: 'Private draft', sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
        inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } },
        body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'PRIVATE-DRAFT-BODY' } } },
      } }, bindings: {} } }],
    });
    const observed = getActionSpec('account.public_profile.update').projectObservationInput?.({ layout: selection });
    expect(observed).not.toHaveProperty('layout');
    expect(JSON.stringify(observed)).not.toContain('PRIVATE-DRAFT-BODY');
  });
  it.each([
    { surface: 'ui', authority: 'present_user', caller: 'host', ask: false, succeeds: true },
    { surface: 'ui', authority: 'present_user', caller: 'host', ask: true, succeeds: true },
    { surface: 'agent', authority: 'account_automation', caller: 'host', ask: false, succeeds: false },
    { surface: 'ui', authority: 'account_automation', caller: 'host', ask: false, succeeds: false },
    { surface: 'ui', authority: 'present_user', caller: 'plugin', ask: false, succeeds: false },
  ] as const)('counts the exact prepared review as confirmation only for the present host UI user ($surface/$authority/$caller/ask=$ask)', async scenario => {
    const current = owner();
    if (current.kind !== 'ready') throw new Error('Expected existing edition');
    current.record.query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1_000 } });
    const writes: unknown[] = [];
    const reviewedRequests: unknown[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      if (args.actionId === 'account.public_profile.get') return current;
      writes.push(args.preparedRequest);
      return { kind: 'updated', record: null };
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {}, buildSnapshot: buildPublicProfileSnapshot,
        usage: { query: async ({ queries }) => resolveUsagePageAggregation({ queries, accounting: queries.map(query => ({ query,
          status: 'available', asOfMs: 1_000, value: UsageAnalyticsQueryResponseSchema.parse({ v: 1,
            totals: { eventCount: 1, tokens: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 5 },
              cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
            contributions: [{ id: 'request', observedAtMs: 1, sessionId: null, turnId: null, agentId: 'codex', modelId: null,
              machineId: null, projectKey: null, workspaceId: null, source: 'runtime', eventCount: 1,
              tokens: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 5 },
              cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }],
          }) })) }) } }),
    } as ActionExecutorDeps);
    const result = await executor.execute('account.public_profile.publish', {
      intent: 'publish', policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadataSelection: {},
      query: current.record.query, layout, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
    }, { ...context, surface: scenario.surface, authority: scenario.authority,
      actionCaller: scenario.caller === 'host' ? { kind: 'host' } : { kind: 'plugin', pluginId: 'example.profiles', contributionLocalId: 'surface' },
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, ...(scenario.ask ? {
        actions: { 'account.public_profile.publish': { approvalRequiredSurfaces: ['ui'] } },
      } : {}) }),
      reviewPublicProfilePreparedAction: async effect => {
        reviewedRequests.push(structuredClone(effect.request));
        return effect.request.operation === 'publish';
      },
    });
    expect(result, !result.ok ? JSON.stringify({ errorCode: result.errorCode, error: result.error }) : undefined)
      .toMatchObject({ ok: scenario.succeeds });
    expect(writes).toHaveLength(scenario.succeeds ? 1 : 0);
    if (scenario.succeeds) expect(writes).toEqual(reviewedRequests);
  });
  it('refuses a prepared-publication confirmation when the reviewed payload changes', async () => {
    let writes = 0;
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      if (args.actionId === 'account.public_profile.get') return owner();
      writes += 1;
      return { kind: 'updated', record: null };
    };
    const policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields } };
    for (const field of PUBLIC_PROFILE_FIELDS_V1) policy.fields[field] = field === 'bio';
    const input = { intent: 'publish', policy, metadataSelection: { bio: 'Reviewed biography' },
      query: normalizeUsageQuery({ period: { relative: 'all' } }), layout, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
    } as ActionExecutorDeps);
    const result = await executor.execute('account.public_profile.publish', {
      ...input, metadataSelection: { bio: 'Changed biography' },
    }, { ...context, surface: 'ui', actionCaller: { kind: 'host' },
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {
        'account.public_profile.publish': { approvalRequiredSurfaces: ['ui'] },
      } }),
      presentUserConfirmation: { actionId: 'account.public_profile.publish',
        inputDigest: computeActionInputApprovalDigestV1('account.public_profile.publish', input),
        requestId: context.actionRequestId, accountId: context.runtimeAccountId, serverId: context.serverId, target: null },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
    expect(writes).toBe(0);
  });
  it.each(['publish', 'resume', 'update', 'refresh'] as const)('requires a declared public population in the prepared %s HTTP grammar', operation => {
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1 } });
    const snapshot = PublicProfileSnapshotV1Schema.parse({ v: 1, computedAtMs: 1,
      period: { startMs: 0, endMs: 1, timeZoneOffsetMinutes: 0 }, coverage: { status: 'unknown', method: 'unknown' },
      fieldCoverage: {}, facts: {},
    });
    const body = operation === 'update' ? { query } : operation === 'publish'
      ? { query, snapshot, policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, projectSelections: [], layout,
        appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 }
      : { query, snapshot };
    const actionId = `account.public_profile.${operation}` as const;
    expect(() => bindPublicProfilePreparedHttpRequestV1(actionId, { operation, body })).toThrow();
    const { population: _privatePopulation, ...unspecifiedQuery } = query;
    expect(() => bindPublicProfilePreparedHttpRequestV1(actionId, { operation, body: { ...body, query: unspecifiedQuery } })).toThrow();
    expect(bindPublicProfilePreparedHttpRequestV1(actionId, { operation,
      body: { ...body, query: { ...query, population: 'public_eligible_personal' } },
    }).body).toMatchObject({ query: { population: 'public_eligible_personal' } });
  });

  it('keeps public Action intents distinct from strict prepared HTTP effects', () => {
    const body = { metadata: { bio: 'Explicit reviewed bio' } };
    expect(getActionSpec('account.public_profile.update').inputSchema.safeParse(body).success).toBe(false);
    expect(bindPublicProfilePreparedHttpRequestV1('account.public_profile.update', { operation: 'update', body }))
      .toEqual({ method: 'PUT', path: '/v1/account/public-profile/policy', body });
    expect(() => bindPublicProfilePreparedHttpRequestV1('account.public_profile.refresh', { operation: 'update', body })).toThrow();
    expect(() => bindPublicProfilePreparedHttpRequestV1('account.public_profile.update', {
      operation: 'update', body: { ...body, state: 'published', confirmed: true },
    })).toThrow();
  });
  it.each(['cli', 'plugin'] as const)('applies a layout from %s without reading Usage and acknowledges the applied edition', async surface => {
    const current = owner();
    const requests: unknown[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      const request = args.preparedRequest ? bindPublicProfilePreparedHttpRequestV1(args.actionId, args.preparedRequest)
        : bindHomeDomainActionHttpRequestV1(args.actionId, args.input);
      requests.push(request);
      return args.actionId === 'account.public_profile.get' ? current : { kind: 'updated', record: current.kind === 'ready' ? current.record : null };
    };
    const executor = createActionExecutor({
      isActionApprovalRequired: approvalRequired,
      homeDomainAction,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
    } as ActionExecutorDeps);
    await expect(executor.execute('account.public_profile.update', { layout }, { ...context, surface,
      ...(surface === 'plugin' ? { actionCaller: { kind: 'plugin' as const, pluginId: 'example.profiles', contributionLocalId: 'surface' } } : {}) }))
      .resolves.toMatchObject({ ok: true, result: { kind: 'updated' } });
    expect(requests).toEqual([{ method: 'GET', path: '/v1/account/public-profile', body: undefined },
      { method: 'PUT', path: '/v1/account/public-profile/policy', body: { layout } }]);
  });

  it('refuses raw snapshots and caller confirmation before any Account transport', async () => {
    const requests: unknown[] = [];
    const executor = createActionExecutor({ homeDomainAction: async args => { requests.push(args); return {}; } } as ActionExecutorDeps);
    await expect(executor.execute('account.public_profile.refresh', { snapshot: {}, confirmed: true }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(requests).toEqual([]);
  });

  it.each(['retained', 'missing', 'period', 'wider'] as const)('uses the live preview only for compatible Publish facts: %s', async scenario => {
    const policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields } };
    for (const field of PUBLIC_PROFILE_FIELDS_V1) policy.fields[field] = field === 'tokens';
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1_000 } });
    const queries: UsageQuery[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async () => owner();
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {}, buildSnapshot: buildPublicProfileSnapshot,
        usage: { query: async request => {
          queries.push(...request.queries);
          return resolveUsagePageAggregation({ queries: request.queries, accounting: request.queries.map(query => ({ query,
            status: 'available', asOfMs: 1_000, value: UsageAnalyticsQueryResponseSchema.parse({ v: 1,
              totals: { eventCount: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }, contributions: [],
              coverage: { status: 'complete', reasons: [], missingDimensions: [], ranked: [],
                range: { startMs: 0, endMs: 1_000, complete: true }, sources: [] },
            }),
          })) });
        } },
      }),
    } as ActionExecutorDeps);
    const intent = { policy, metadataSelection: {}, query, layout, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 };
    let preview: PublicProfilePreviewAdmission | null = null;
    expect(await executor.execute('account.public_profile.preview', intent, { ...context,
      capturePublicProfilePreview: admitted => { preview = admitted; },
    })).toMatchObject({ ok: true, result: { kind: 'ready' } });
    expect(preview).not.toBeNull();
    const reviewed: PreparedPublicProfileAction[] = [];
    expect(await executor.execute('account.public_profile.publish', { ...intent, intent: 'publish',
      ...(scenario === 'period' ? { query: normalizeUsageQuery({ period: { startMs: 0, endMs: 2_000 } }) } : {}),
      ...(scenario === 'wider' ? { policy: { ...policy, fields: { ...policy.fields, activeDays: true } } } : {}),
    }, { ...context, publicProfilePreviewAdmission: Promise.resolve(scenario === 'missing' ? null : preview),
      reviewPublicProfilePreparedAction: async effect => { reviewed.push(effect); return false; },
    })).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
    expect(reviewed).toHaveLength(1);
    expect(queries).toHaveLength(scenario === 'retained' ? 1 : 2);
  });

  it.each([
    { missing: 'report', reason: 'report_contact_unconfigured' },
    { missing: 'ingress', reason: 'public_ingress_unconfigured' },
    { missing: 'usage', reason: 'usage_unavailable' },
  ] as const)('keeps local preview independent of Publish prerequisites ($missing)', async ({ missing, reason }) => {
    const requests: unknown[] = [];
    const queried: unknown[] = [];
    const canonicalContext = owner().context;
    // Actual server context: a claimed handle and configured service still
    // have null URLs when the canonical report contact is unconfigured.
    const read = PublicProfileOwnerReadV1Schema.parse({ kind: 'absent', context: { ...canonicalContext,
      ...(missing === 'ingress' ? { service: null } : {}), ...(missing !== 'usage' ? { urls: null } : {}),
    } });
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      requests.push(args.actionId); return read;
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {},
        buildSnapshot: buildPublicProfileSnapshot,
        ...(missing === 'usage' ? {} : { usage: { query: async ({ queries }) => {
          queried.push(...queries);
          return resolveUsagePageAggregation({ queries, accounting: queries.map(query => ({ query,
            status: 'available', asOfMs: 1_000, value: UsageAnalyticsQueryResponseSchema.parse({ v: 1,
              totals: { eventCount: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }, contributions: [],
              coverage: { status: 'complete', reasons: [], missingDimensions: [], ranked: [],
                range: { startMs: 0, endMs: 1_000, complete: true }, sources: [] },
            }),
          })) });
        } } }),
      }),
    } as ActionExecutorDeps);
    const intent = { policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadataSelection: {},
      query: normalizeUsageQuery({ period: { relative: '30days' } }), layout, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 };
    const result = await executor.execute('account.public_profile.preview', intent, context);
    expect(result).toMatchObject({ ok: true, result: { kind: missing === 'usage' ? 'unavailable' : 'ready' } });
    if (!result.ok) throw new Error('Expected a local preview result');
    const preview = PublicProfilePreviewResultV1Schema.parse(result.result);
    if (preview.kind === 'ready') {
      expect(preview.view.relativePeriod).toBe('30days');
      expect(preview.view.service).toEqual(read.context.service);
      expect(preview.view.urls).toBeNull();
      expect(PublicProfileViewV1Schema.safeParse(preview.view).success).toBe(false);
    } else expect(preview.reason).toBe(reason);
    expect(requests).toEqual(['account.public_profile.get']);
    expect(queried).toHaveLength(missing === 'usage' ? 0 : 1);
    await expect(executor.execute('account.public_profile.publish', { ...intent, intent: 'publish' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'public_profile_preparation_unavailable', details: { reason } });
    expect(requests).toEqual(['account.public_profile.get', 'account.public_profile.get']);
    expect(queried).toHaveLength(missing === 'usage' ? 0 : 1);
  });

  it('retains the exact image Apply through blocking approval without uploading its bytes in the Approval Artifact', async () => {
    let current = owner();
    let stored: ApprovalRequest | null = null;
    let offeredBeforeDecision: unknown;
    const requests: unknown[] = [];
    const candidate: { layout: typeof layout; appearance: PublicProfilePreparedAppearanceV1 } = { layout, appearance: reviewedPictureAppearance() };
    const reviewed = structuredClone(candidate);
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      if (args.actionId === 'account.public_profile.get') return current;
      const request = bindPublicProfilePreparedHttpRequestV1(args.actionId, args.preparedRequest);
      requests.push(request);
      return { kind: 'updated', record: current.kind === 'ready' ? current.record : null };
    };
    const executor = createActionExecutor({ homeDomainAction,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
      approvalsCreate: async ({ request }) => {
        offeredBeforeDecision = structuredClone(request);
        stored = ApprovalRequestV2Schema.parse(request);
        return { artifactId: 'apply-approval' };
      },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        if (!stored) throw new Error('Missing approval');
        const next = decideApprovalRequestTransition(stored, request);
        if (!next.ok) return next;
        stored = ApprovalRequestV2Schema.parse(request);
        return { ok: true };
      },
      approvalsWaitForDecision: async ({ request }) => {
        expect(requests).toEqual([]);
        expect(request.preview).toMatchObject({ destination: { serverId: 'home', accountId: 'account' } });
        // The caller's local draft and server policy move while review is open.
        candidate.appearance.atmosphere = { source: 'none' };
        Object.assign(candidate.appearance, { theme: 'dark' });
        current = PublicProfileOwnerReadV1Schema.parse({ ...current, record: { ...(current.kind === 'ready' ? current.record : {}),
          policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens: false } } } });
        return { decision: 'approve', decisionAuthority: 'present_user', request };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    } as ActionExecutorDeps);
    const result = await executor.execute('account.public_profile.update', candidate, { ...context, surface: 'agent', authority: 'account_automation',
      runtimeAccountId: 'account', actionCaller: { kind: 'host' }, actionRequestId: 'apply-request', defaultSessionMachineId: 'machine' });
    // Assert outside the boundary callback so the executor cannot normalize this regression into a generic failure.
    expect(offeredBeforeDecision).toBeDefined();
    expect(JSON.stringify(offeredBeforeDecision)).not.toContain(picturePng);
    expect(result).toMatchObject({ ok: true, result: { kind: 'updated', record: { policy: { fields: { tokens: false } } } } });
    expect(requests).toEqual([{ method: 'PUT', path: '/v1/account/public-profile/policy', body: reviewed }]);
  });

  it('applies a policy narrowing without querying Usage or adding refresh result states', async () => {
    const current = owner();
    const requests: unknown[] = [];
    const policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens: false } };
    const record = current.kind === 'ready' ? { ...current.record, policy } : null;
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      requests.push(args.actionId);
      return args.actionId === 'account.public_profile.get' ? current : { kind: 'updated', record };
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {},
        usage: { query: async () => { throw new Error('Narrowing must not query Usage'); } } }),
    } as ActionExecutorDeps);
    await expect(executor.execute('account.public_profile.update', { policy }, context)).resolves.toMatchObject({ ok: true,
      result: { kind: 'updated', record: { policy: { fields: { tokens: false } } } } });
    expect(requests).toEqual(['account.public_profile.get', 'account.public_profile.update']);
  });

  it.each([
    { empty: true, reason: 'no_eligible_personal_usage' },
    { empty: false, reason: 'source_time_unavailable' },
  ] as const)('preserves $reason through preview and publication without reading Usage for an unchanged policy', async ({ empty, reason }) => {
    const current = owner();
    if (current.kind !== 'ready') throw new Error('Expected existing edition');
    current.record.query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1_000 } });
    const writes: unknown[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      if (args.actionId === 'account.public_profile.get') return current;
      writes.push(args.actionId);
      return { kind: 'updated', record: current.record };
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {}, buildSnapshot: buildPublicProfileSnapshot,
        usage: { query: async ({ queries }) => resolveUsagePageAggregation({ queries, accounting: queries.map(query => ({ query,
          status: 'available', value: UsageAnalyticsQueryResponseSchema.parse({ v: 1,
            totals: { eventCount: empty ? 0 : 1,
              tokens: { input: empty ? 0 : 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: empty ? 0 : 10 },
              cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
            contributions: empty ? [] : [{ id: 'request', observedAtMs: 1, sessionId: null, turnId: null, agentId: 'codex', modelId: null,
              machineId: null, projectKey: null, workspaceId: null, source: 'runtime', eventCount: 1,
              tokens: { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 },
              cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }],
            coverage: { status: 'partial', reasons: ['incomplete_history'], missingDimensions: [], ranked: [],
              range: { startMs: 0, endMs: 1_000, complete: false }, sources: [] },
          }),
        })) }) },
      }),
    } as ActionExecutorDeps);
    const intent = { policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadataSelection: {}, query: current.record.query,
      layout, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 };
    const preview = await executor.execute('account.public_profile.preview', intent, context);
    expect(preview).toEqual({ ok: true, result: { kind: 'unavailable', reason } });
    if (!preview.ok) throw new Error('Expected local preview result');
    expect(PublicProfilePreviewResultV1Schema.parse(preview.result)).toEqual({ kind: 'unavailable', reason });
    for (const operation of ['publish', 'refresh', 'resume'] as const) {
      current.record.state = operation === 'resume' ? 'paused' : 'published';
      await expect(executor.execute(`account.public_profile.${operation}`,
        operation === 'publish' ? { ...intent, intent: 'publish' } : {}, context)).resolves.toMatchObject({
        ok: false, errorCode: 'public_profile_preparation_unavailable', details: { reason },
      });
    }
    expect(writes).toEqual([]);
    current.record.state = 'published';
    const updated = await executor.execute('account.public_profile.update', { policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1 }, context);
    expect(updated).toMatchObject({ ok: true, result: { kind: 'updated' } });
    if (!updated.ok) throw new Error('Expected acknowledged policy update');
    expect(PublicProfileUpdateResultV1Schema.parse(updated.result)).toEqual({ kind: 'updated', record: current.record });
    expect(writes).toEqual(['account.public_profile.update']);
  });

  it.each(['publish', 'resume', 'refresh', 'preview', 'preview_required'] as const)('keeps the exact computed %s snapshot out of durable approvals and observations', async variant => {
    const coordinator = createBlockingApprovalCoordinator();
    const operation = variant === 'preview_required' ? 'preview' : variant;
    const current = owner();
    if (current.kind !== 'ready') throw new Error('Expected existing edition');
    current.record.state = operation === 'resume' ? 'paused' : 'published';
    current.record.query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1_000 } });
    current.context.handle = 'current_owner';
    current.context.identity = { name: 'Current Owner' };
    current.context.service = { displayName: 'Current Home', publicBaseUrl: 'https://current-home.test' };
    current.context.urls = { page: 'https://current-home.test/@current_owner', json: 'https://current-home.test/@current_owner/json',
      badgeBase: 'https://current-home.test/@current_owner/badge', card: 'https://current-home.test/@current_owner/card.svg',
      og: 'https://current-home.test/@current_owner/og.png', report: 'mailto:operator@current-home.test' };
    const publicationContext = structuredClone(current.context);
    let stored: ApprovalRequest | null = null;
    let offered: unknown;
    let observedTokens = 1234567;
    const writes: unknown[] = [];
    const observations: unknown[] = [];
    const reviewOrder: string[] = [];
    const reviewed: PreparedPublicProfileAction[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      if (args.actionId === 'account.public_profile.get') return current;
      writes.push(bindPublicProfilePreparedHttpRequestV1(args.actionId, args.preparedRequest));
      return { kind: 'updated', record: null };
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {}, buildSnapshot: buildPublicProfileSnapshot,
        usage: { query: async ({ queries }) => resolveUsagePageAggregation({ queries, accounting: queries.map(query => ({ query,
          status: 'available', asOfMs: 1_000, value: UsageAnalyticsQueryResponseSchema.parse({ v: 1,
            totals: { eventCount: 1, tokens: { input: observedTokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: observedTokens },
              cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
            contributions: [{ id: 'request', observedAtMs: 1, sessionId: null, turnId: null, agentId: 'codex', modelId: null,
              machineId: null, projectKey: null, workspaceId: null, source: 'runtime', eventCount: 1,
              tokens: { input: observedTokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: observedTokens },
              cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }],
          }) })) }) } }),
      approvalsCreate: async ({ request }) => { reviewOrder.push('approval'); offered = structuredClone(request); stored = request; return { artifactId: 'snapshot-review' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        if (!stored) throw new Error('Missing approval');
        const next = decideApprovalRequestTransition(stored, request);
        if (!next.ok) return next;
        stored = request;
        coordinator.notifyApprovalUpdated({ artifactId: 'snapshot-review', request });
        return { ok: true };
      },
      approvalsWaitForDecision: async ({ request }) => {
        observedTokens = 7654321;
        const decision = await coordinator.waitForDecision({ artifactId: 'snapshot-review', request,
          readRequest: async () => stored, subscribeChanges: listener => coordinator.subscribeApprovalChanges(listener) });
        return { ...decision, request: ApprovalRequestV2Schema.parse(decision.request) };
      }, isApprovalExecutionOriginCurrent: async () => true,
      approvalsResolveBlockingDecision: args => coordinator.resolveBlockingDecision(args),
      observeActionExecution: observation => { observations.push(observation); },
    } as ActionExecutorDeps);
    const appearance = operation === 'preview' ? reviewedPictureAppearance() : DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1;
    const input = operation === 'publish' || operation === 'preview' ? { ...(operation === 'publish' ? { intent: 'publish' } : {}),
      policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadataSelection: { bio: 'private-unreviewed-bio', projectSelections: [{
        provider: { id: 'example/forge', kind: 'custom', displayName: 'Forge', baseUrl: 'https://forge.test' },
        repository: { nameWithOwner: 'private-unreviewed-owner/private-repo' }, protocol: 'https',
      }] },
      query: current.record.query, layout, appearance } : {};
    const previewSettings = variant === 'preview_required' || operation === 'refresh' ? ActionsSettingsV1Schema.parse({ v: 1,
      actions: { [`account.public_profile.${operation}`]: { approvalRequiredSurfaces: ['agent'] } } }) : settings;
    // Native MCP operands cross JSON framing before Action admission.
    const pending = executor.execute(`account.public_profile.${operation}`, projectNativeJsonValueForTransport(input), { ...context, actionsSettings: previewSettings,
      surface: 'agent', authority: 'account_automation',
      reviewPublicProfilePreparedAction: async (effect: PreparedPublicProfileAction) => {
        reviewOrder.push('review');
        reviewed.push(structuredClone(effect));
        observedTokens = 2345678;
        return true;
      },
      runtimeAccountId: 'account', actionCaller: { kind: 'host' }, actionRequestId: 'snapshot-request', defaultSessionMachineId: 'machine' });
    let result: Awaited<typeof pending>;
    try {
      if (variant !== 'preview') {
        await vi.waitFor(() => expect(coordinator.getLiveWaiterCount('snapshot-review')).toBe(1));
        expect(writes).toEqual([]);
        expect(await executor.execute('approval.request.decide', { artifactId: 'snapshot-review', decision: 'approve' }, {
          surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        })).toMatchObject({ ok: true });
      }
      result = await pending;
      expect(result.ok, !result.ok ? JSON.stringify({ errorCode: result.errorCode, error: result.error, details: result.details }) : undefined)
        .toBe(variant !== 'preview_required');
    } finally { coordinator.dispose(); }
    expect(reviewOrder).toEqual(operation === 'preview' ? variant === 'preview_required' ? ['approval'] : [] : ['review', 'approval']);
    expect(reviewed).toHaveLength(operation === 'preview' ? 0 : 1);
    if (offered !== undefined) expect(JSON.stringify(offered)).not.toContain('private-unreviewed');
    expect(observations.length).toBeGreaterThan(0);
    expect(JSON.stringify(observations)).not.toContain('private-unreviewed');
    expect(JSON.stringify(observations)).not.toContain('1234567');
    expect(JSON.stringify(observations)).not.toContain(picturePng);
    if (operation === 'preview') {
      if (variant === 'preview_required') {
        expect(offered).toBeDefined();
        expect(JSON.stringify(stored)).not.toContain('1234567');
        expect(JSON.stringify(stored)).not.toContain(picturePng);
      } else expect(offered).toBeUndefined();
      expect(writes).toEqual([]);
      if (variant === 'preview_required') expect(result).toMatchObject({ ok: false, errorCode: 'approval_result_held' });
      else expect(result).toMatchObject({ ok: true, result: { kind: 'ready', view: { appearance, snapshot: { facts: { tokens: 1234567 } } } } });
      return;
    }
    expect(offered).toBeDefined();
    expect(JSON.stringify(offered)).not.toContain('1234567');
    expect(reviewed[0]).toMatchObject({ publicationContext });
    expect(result).toMatchObject({ ok: true, result: { kind: 'updated' } });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ body: { snapshot: { facts: { tokens: 1234567 } } } });
    expect(writes[0]).toMatchObject({ body: reviewed[0]!.request.body });
    expect(writes[0]).not.toHaveProperty('body.publicationContext');
    expect(JSON.stringify(writes)).not.toContain('private-unreviewed');
  });

  it.each(['cancel', 'abort'] as const)('stops %s during prepared review before approval or an outward write', async outcome => {
    const controller = new AbortController();
    const effects: string[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      if (args.actionId === 'account.public_profile.get') return owner();
      effects.push('write');
      return { kind: 'updated', record: null };
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
      approvalsCreate: async () => { effects.push('approval'); return { artifactId: 'unexpected-approval' }; },
    } as ActionExecutorDeps);
    const result = await executor.execute('account.public_profile.update', { layout }, { ...context, surface: 'ui', authority: 'present_user',
      actionCaller: { kind: 'host' }, signal: controller.signal,
      reviewPublicProfilePreparedAction: async (effect: PreparedPublicProfileAction) => {
        effects.push('review');
        expect(effect.request).toEqual({ operation: 'update', body: { layout } });
        if (outcome === 'abort') controller.abort();
        return outcome !== 'cancel';
      },
    });
    expect(result).toMatchObject({ ok: false, errorCode: { cancel: 'approval_canceled', abort: 'cancelled' }[outcome] });
    expect(effects).toEqual(['review']);
  });

  it('refuses a query change without a snapshot builder before applying any part of Update', async () => {
    const current = owner();
    const requests: unknown[] = [];
    const ordinaryQuery = normalizeUsageQuery({ period: { relative: '30days' }, agents: ['claude'] });
    const publicQuery = normalizeUsageQuery({ ...ordinaryQuery, population: 'public_eligible_personal', includeAccounting: true,
      includeComparison: false,
      includeActivity: true, activityResolution: 'both', includeSessionEvidence: true, includeWorkEvidence: true,
      includeQuotaHistory: false, includeTranscriptEvidence: false });
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      const request = args.preparedRequest ? bindPublicProfilePreparedHttpRequestV1(args.actionId, args.preparedRequest)
        : bindHomeDomainActionHttpRequestV1(args.actionId, args.input);
      requests.push(request);
      return args.actionId === 'account.public_profile.get' ? current
        : { kind: 'updated', record: current.kind === 'ready' ? { ...current.record, query: publicQuery } : null };
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
    } as ActionExecutorDeps);
    await expect(executor.execute('account.public_profile.update', { query: ordinaryQuery }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'public_profile_preparation_unavailable', details: { reason: 'usage_unavailable' } });
    expect(requests).toEqual([{ method: 'GET', path: '/v1/account/public-profile', body: undefined }]);
    expect(ordinaryQuery.population).toBe('all_personal_history');
  });

  it('aborts a retired captured operation after preparation before any retained Apply', async () => {
    const controller = new AbortController();
    const requests: unknown[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      if (args.actionId === 'account.public_profile.get') return owner();
      requests.push(args); return { kind: 'updated', record: null };
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
    } as ActionExecutorDeps);
    const prepared = await executor.prepare('account.public_profile.update', { layout }, { ...context, signal: controller.signal });
    expect(prepared.kind).toBe('ready');
    controller.abort();
    if (prepared.kind !== 'ready') throw new Error('Expected a prepared Apply');
    await expect(prepared.invocation.run()).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(requests).toEqual([]);
  });

  it('cancels after the captured Account read before retaining or dispatching any prepared write', async () => {
    const controller = new AbortController();
    const requests: unknown[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      requests.push(args.actionId);
      controller.abort();
      return owner();
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
    } as ActionExecutorDeps);
    await expect(executor.execute('account.public_profile.update', { layout }, { ...context, signal: controller.signal }))
      .resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(requests).toEqual(['account.public_profile.get']);
  });

  it('keeps UI approval waivers separate from CLI consent and honors Off before preparation', async () => {
    const requests: string[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      requests.push(args.actionId); return owner();
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
    } as ActionExecutorDeps);
    const uiOnly = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'account.public_profile.update': ['ui'] } });
    await expect(executor.execute('account.public_profile.update', { layout }, { ...context, actionsSettings: uiOnly }))
      .resolves.toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(requests).toEqual(['account.public_profile.get']);
    requests.length = 0;
    const off = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'account.public_profile.update': { disabledSurfaces: ['cli'] } } });
    await expect(executor.execute('account.public_profile.update', { layout }, { ...context, actionsSettings: off }))
      .resolves.toMatchObject({ ok: false });
    expect(requests).toEqual([]);
  });
});
