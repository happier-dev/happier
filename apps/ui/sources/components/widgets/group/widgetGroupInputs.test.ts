import { describe, expect, it } from 'vitest';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { resolveConfiguredWidgetInputs } from '@happier-dev/protocol/widgets';
import { buildWidgetCandidateSetup } from '@/components/widgets/surface/widgetSurfaceSetup';
import { buildWidgetGroupInputsCandidate, collectWidgetGroupInputFields } from './widgetGroupInputs';

const candidate = (fields: NonNullable<WidgetCandidate['inputs']>['fields']): Extract<WidgetCandidate, { definition: unknown }> => ({
  key: 'checks', title: 'Checks', pluginName: 'Checks', sharedPluginName: false,
  icon: 'squares-four', homeDefault: 'available', target: 'app',
  inputs: { fields }, sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
  definition: { kind: 'builtin', id: 'group-input-fixture' },
});

describe('Widget group input collection', () => {
  it('discovers each group field through its declaring follow-able child, retaining its dependencies', () => {
    const period = { path: 'period', title: 'Period', widget: 'select' as const, optionsSourceId: 'periods' };
    const metric = { path: 'metric', title: 'Metric', widget: 'select' as const, optionsSourceId: 'metrics' };
    const children: WidgetCandidate[] = [
      { ...candidate([period, { ...metric, contextMode: 'own' as const }]), definition: { kind: 'builtin' as const, id: 'first' } },
      { ...candidate([metric, { path: 'session', title: 'Session', widget: 'json' as const, inputType: { hostType: 'session' as const } }]),
        definition: { kind: 'builtin' as const, id: 'second' } },
    ];
    const descriptor = buildWidgetGroupInputsCandidate({ title: 'Group', candidates: children })!;
    const setup = buildWidgetCandidateSetup({ candidate: descriptor, fieldCandidates: children, context: {}, audience: 'personal',
      scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' } },
      mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }) });
    const draft = { bindings: { period: { kind: 'value' as const, value: 'month' }, metric: { kind: 'value' as const, value: 'cost' },
      session: { kind: 'value' as const, value: { serverId: 'home', sessionId: 'B' } } } };
    expect(setup.optionsContext?.(draft, period)?.consumer).toMatchObject({ definition: children[0]!.definition });
    const discovery = setup.optionsContext?.(draft, metric);
    expect(discovery?.consumer).toMatchObject({ definition: children[1]!.definition, selectedSession: { serverId: 'home', sessionId: 'B' } });
    expect(discovery?.draftInput).toEqual({ metric: 'cost', session: { serverId: 'home', sessionId: 'B' } });
  });
  it('configures independent Session and Workspace group slots while omitting a child-owned input', () => {
    const fields = [{ path: 'session', title: 'Session', widget: 'json' as const, inputType: { hostType: 'session' as const }, required: true },
      { path: 'checkout', title: 'Checkout', widget: 'json' as const, inputType: { hostType: 'workspace' as const }, required: true },
      { path: 'ownSession', title: 'Own Session', widget: 'json' as const, inputType: { hostType: 'session' as const }, contextMode: 'own' as const }];
    const descriptor = buildWidgetGroupInputsCandidate({ title: 'Group', candidates: [candidate([fields[0]!]), candidate(fields.slice(1))] });
    expect(descriptor?.inputs?.fields.map(field => field.path)).toEqual(['session', 'checkout']);
    const session = { serverId: 'home', sessionId: 'B' };
    const checkout = { serverId: 'home', id: 'checkout', machineId: 'machine', rootPath: '/repo', createdAtMs: 0 };
    expect(resolveConfiguredWidgetInputs({ descriptor: descriptor!, instance: { v: 1, id: 'group', definition: { kind: 'builtin', id: 'group-form' },
      bindings: { session: { kind: 'value', value: session }, checkout: { kind: 'value', value: checkout } } }, providedContext: {}, viewerValues: {} }))
      .toEqual({ status: 'ready', input: { session, checkout } });
  });
  it('collects only follow-able non-credential fields from every child and retains the first compatible declaration', () => {
    const owned = { path: 'metric', title: 'Metric', widget: 'text' as const, contextMode: 'own' as const };
    const period = { path: 'period', title: 'Period', widget: 'text' as const };
    const cost = { path: 'costBasis', title: 'Cost basis', widget: 'text' as const, contextMode: 'follow' as const };
    const children = [{ ...candidate([owned, period, { path: 'connection', title: 'Connection', widget: 'select', connectedAccountOptions: true }]),
      inputSchema: { type: 'object' as const, properties: { metric: { type: 'string' as const, const: 'owned-only' } } } },
      { ...candidate([{ ...owned, title: 'Group metric', contextMode: 'follow' as const }, cost, { ...period, title: 'Later period' }]),
        inputSchema: { type: 'object' as const, properties: { metric: { type: 'string' as const, enum: ['group-choice'] } } } }];
    expect(collectWidgetGroupInputFields(children)).toEqual([period, { ...owned, title: 'Group metric', contextMode: 'follow' }, cost]);
    expect(buildWidgetGroupInputsCandidate({ title: 'Group', candidates: children })?.inputSchema?.properties?.metric)
      .toEqual({ type: 'string', enum: ['group-choice'] });
    expect(buildWidgetGroupInputsCandidate({ title: 'Group', candidates: [candidate([owned])] })).toBeNull();
    const withLaterDefault = buildWidgetGroupInputsCandidate({ title: 'Group', candidates: [candidate([period]),
      { ...candidate([cost]), inputSchema: { type: 'object', properties: { costBasis: { type: 'string', default: 'reported' } } } }] });
    expect(buildWidgetCandidateSetup({ candidate: withLaterDefault!, context: {}, audience: 'personal',
      mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }) }).initial.bindings)
      .toEqual({ costBasis: { kind: 'value', value: 'reported' } });
  });
});
