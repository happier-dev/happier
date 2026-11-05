import { createElement as h, useState, type ReactElement } from 'react';
import {
    HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, HealthCheckHttpConfigV1ProtocolSchema, HealthCheckSetupDraftV1ProtocolSchema,
    HealthCheckSetupInputV1ProtocolSchema, HealthCheckTcpConfigV1ProtocolSchema, isHealthCheckLoopbackRefusedV1,
    type HealthCheckKindV1, type HealthCheckSetupDraftV1, type HealthCheckSetupInputV1, type HealthCheckSubjectV1,
} from '@happier-dev/plugin-sdk';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
    Banner, Button, Column, Columns, Field, Row, Select, SelectionTiles, Stack, Text, TextField,
    defineUiSurface, usePluginHostApi, usePluginTranslation, type IconName,
} from '@happier-dev/plugin-ui';

type Translate = ReturnType<typeof usePluginTranslation>;
type Check = HealthCheckSetupInputV1['checks'][number];
const K = 'machineServices.healthSetup';

/** One kind tile set; copy and marks follow the shared Add check sheet. */
const KINDS: readonly Readonly<{ id: HealthCheckKindV1; title: string; subtitle: string; icon: IconName }>[] = [
    { id: 'http', title: 'HTTP', subtitle: 'A page answers with a status or a word', icon: 'globe' },
    { id: 'tcp', title: 'TCP', subtitle: 'A port accepts connections', icon: 'link' },
    { id: 'dns', title: 'DNS', subtitle: 'A name resolves to what you expect', icon: 'globe' },
    { id: 'certificate', title: 'Certificate', subtitle: 'Valid, and renewing in time', icon: 'locked' },
    { id: 'heartbeat', title: 'Heartbeat', subtitle: 'Your job pings Happier on schedule', icon: 'waveform' },
];
const MINUTE = 60_000;
const PERIODS = [[MINUTE, '1 minute'], [5 * MINUTE, '5 minutes'], [15 * MINUTE, '15 minutes'], [60 * MINUTE, '1 hour']] as const;
const THRESHOLDS = [[1, 'The first failure'], [2, '2 failures in a row'], [3, '3 failures in a row'], [5, '5 failures in a row']] as const;
const GRACE = [[0, 'No grace'], [MINUTE, '1 minute'], [5 * MINUTE, '5 minutes'], [15 * MINUTE, '15 minutes']] as const;
const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'PTR', 'SRV', 'SOA', 'NAPTR', 'CAA'] as const;

type Draft = Readonly<{
    kind: HealthCheckKindV1; endpoint: string; expectStatus: string; keyword: string; host: string; port: string;
    hostname: string; recordType: (typeof RECORD_TYPES)[number]; expectedAnswer: string; graceMs: number;
    periodMs: number; consecutiveFailuresBeforeAlerting: number;
}>;
const EMPTY: Draft = { kind: 'http', endpoint: '', expectStatus: '200', keyword: '', host: '', port: '', hostname: '',
    recordType: 'A', expectedAnswer: '', graceMs: MINUTE, periodMs: MINUTE, consecutiveFailuresBeforeAlerting: 2 };

/** The host hands the prebound draft; an observer, when the host names it, decides loopback in place. */
function readLaunch(input: unknown): Readonly<{ draft: HealthCheckSetupDraftV1; observerMachineId?: string }> | null {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
    const record = input as Readonly<Record<string, unknown>>;
    const draft = HealthCheckSetupDraftV1ProtocolSchema.safeParse(record.initialInput);
    if (!draft.success || draft.data.subject === undefined) return null;
    const observer = record.observerMachineId;
    return { draft: draft.data, ...(typeof observer === 'string' && observer.length > 0 ? { observerMachineId: observer } : {}) };
}

function configFor(draft: Draft): unknown {
    const optional = (key: string, value: string) => (value.trim() ? { [key]: value.trim() } : {});
    if (draft.kind === 'tcp') return { host: draft.host.trim(), port: Number(draft.port) };
    if (draft.kind === 'dns') return { hostname: draft.hostname.trim(), recordType: draft.recordType,
        ...optional('expectedAnswer', draft.expectedAnswer) };
    if (draft.kind === 'heartbeat') return { graceMs: draft.graceMs };
    return { endpoint: draft.endpoint.trim(), expectStatus: Number(draft.expectStatus), ...optional('keyword', draft.keyword) };
}

/** A new check never replaces one the source already holds: its id is the kind, made unique. */
function nextCheckId(kind: HealthCheckKindV1, existing: readonly Readonly<{ checkId: string }>[]): string {
    const taken = new Set(existing.map(check => check.checkId));
    if (!taken.has(kind)) return kind;
    let index = 2;
    while (taken.has(`${kind}-${index}`)) index += 1;
    return `${kind}-${index}`;
}

export function buildHealthCheckSetupInput(subject: HealthCheckSubjectV1, existing: readonly Check[], draft: Draft) {
    return HealthCheckSetupInputV1ProtocolSchema.safeParse({ v: 1, subject, checks: [...existing, {
        checkId: nextCheckId(draft.kind, existing), kind: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: draft.kind },
        binding: { kind: 'healthCheck' }, config: configFor(draft),
        periodMs: draft.periodMs, consecutiveFailuresBeforeAlerting: draft.consecutiveFailuresBeforeAlerting,
    }] });
}

/** Field problems come from the kind's own config schema; empty fields only keep Add check unavailable. */
function fieldIssues(draft: Draft, text: Translate) {
    const http = draft.kind === 'http' || draft.kind === 'certificate';
    const endpointValid = HealthCheckHttpConfigV1ProtocolSchema.safeParse({ endpoint: draft.endpoint.trim(), expectStatus: 200 }).success;
    const statusValid = !endpointValid || HealthCheckHttpConfigV1ProtocolSchema.safeParse(configFor(draft)).success;
    const portValid = HealthCheckTcpConfigV1ProtocolSchema.safeParse({ host: 'host', port: Number(draft.port) }).success;
    return {
        endpoint: http && draft.endpoint.trim() && !endpointValid
            ? text(`${K}.endpoint.invalid`, 'Enter an http:// or https:// address, without a user name or password.') : undefined,
        expectStatus: http && draft.expectStatus.trim() && !statusValid
            ? text(`${K}.expectStatus.invalid`, 'Use a status code from 100 to 599.') : undefined,
        port: draft.kind === 'tcp' && draft.port.trim() && !portValid
            ? text(`${K}.port.invalid`, 'Use a port from 1 to 65535.') : undefined,
    };
}

/** Equal columns that recompose to one on narrow widths (the shared Columns owner). */
function columns(key: string, count: 2 | 3, ...cells: ReactElement[]) {
    return h(Columns, { key, columns: count, minColumnWidth: 180 }, ...cells.map((cell, index) => h(Column, { key: index }, cell)));
}

function choice<T extends number>(
    label: string, value: T, options: readonly (readonly [T, string])[], onChange: (next: T) => void, testID: string,
) {
    return h(Field, { label },
        h(Select, { label, presentation: 'field', value, testID,
            options: options.map(([option, title]) => ({ value: option, label: title })),
            onChange: next => { if (typeof next === 'number') onChange(next as T); } }));
}

function text(label: string, value: string, onChange: (next: string) => void, options: Readonly<{
    description?: string; issue?: string; placeholder?: string; monospace?: boolean; url?: boolean; numeric?: boolean;
    required?: boolean; testID: string;
}>) {
    return h(Field, { label, ...(options.description ? { description: options.description } : {}),
        ...(options.issue ? { issue: options.issue } : {}), required: options.required ?? true },
    h(TextField, { label, value, onChange, presentation: 'field', testID: options.testID,
        ...(options.placeholder ? { placeholder: options.placeholder } : {}),
        ...(options.monospace ? { monospace: true } : {}),
        ...(options.url ? { keyboardType: 'url' as const, autoCapitalize: 'none' as const, autoCorrect: false } : {}),
        ...(options.numeric ? { keyboardType: 'numeric' as const } : {}) }));
}

function HealthCheckSetupForm(props: Readonly<{ subject: HealthCheckSubjectV1; existing: readonly Check[];
    observerMachineId?: string; signal: AbortSignal }>): ReactElement {
    const t = usePluginTranslation();
    const host = usePluginHostApi();
    const [draft, setDraft] = useState<Draft>(EMPTY);
    const [saving, setSaving] = useState(false);
    const [refusedSave, setRefusedSave] = useState(false);
    const set = (patch: Partial<Draft>) => { setDraft(current => ({ ...current, ...patch })); setRefusedSave(false); };
    const issues = fieldIssues(draft, t);
    const candidate = buildHealthCheckSetupInput(props.subject, props.existing, draft);
    const loopback = props.observerMachineId === undefined ? null : {
        refused: isHealthCheckLoopbackRefusedV1({ subject: props.subject, observerMachineId: props.observerMachineId,
            kindLocalId: draft.kind, config: configFor(draft) }),
        sameMachine: props.subject.kind === 'machineService' && props.observerMachineId === props.subject.machineId,
    };
    const hostBearing = draft.kind === 'http' || draft.kind === 'certificate' || draft.kind === 'tcp';
    const hostHint = loopback?.sameMachine
        ? t(`${K}.loopback.sameMachine`, 'Checked from the service’s own Machine: this catches a stopped service, not a broken route or firewall.')
        : t(`${K}.loopback.hint`, 'A loopback address such as 127.0.0.1 works only when the check runs on the service’s own Machine.');
    const canAdd = candidate.success && loopback?.refused !== true && !saving;

    const refusal = hostBearing && loopback?.refused ? h(Banner, { key: 'loopback', tone: 'warning', testID: 'health-setup-loopback-refused',
            title: t(`${K}.loopback.refused.title`, 'This address means the Machine running the check'),
            description: t(`${K}.loopback.refused.description`,
                'A check from another Machine would connect to itself, not to this service. Run the check on the service’s own Machine, or enter an address other Machines can reach.') }) : null;
    const cadence = [
        choice(draft.kind === 'heartbeat' ? t(`${K}.every.heartbeat`, 'Expect a ping every') : t(`${K}.every`, 'Every'),
            draft.periodMs, PERIODS, periodMs => set({ periodMs }), 'health-setup-every'),
        choice(t(`${K}.alertAfter`, 'Alert after'), draft.consecutiveFailuresBeforeAlerting, THRESHOLDS,
            consecutiveFailuresBeforeAlerting => set({ consecutiveFailuresBeforeAlerting }), 'health-setup-alert-after'),
    ];
    const fields = draft.kind === 'tcp' ? [
        text(t(`${K}.host`, 'Host'), draft.host, value => set({ host: value }), { monospace: true, url: true,
            placeholder: 'db.internal', description: hostHint, testID: 'health-setup-host' }),
        refusal,
        columns('cadence', 3,
            text(t(`${K}.port`, 'Port'), draft.port, value => set({ port: value }), { numeric: true, placeholder: '5432',
                ...(issues.port ? { issue: issues.port } : {}), testID: 'health-setup-port' }),
            ...cadence),
    ] : draft.kind === 'dns' ? [
        columns('target', 2,
            text(t(`${K}.hostname`, 'Name'), draft.hostname, value => set({ hostname: value }), { monospace: true, url: true,
                placeholder: 'shop.example.com', testID: 'health-setup-hostname' }),
            h(Field, { label: t(`${K}.recordType`, 'Record') }, h(Select, { label: t(`${K}.recordType`, 'Record'),
                presentation: 'field', value: draft.recordType, testID: 'health-setup-record-type',
                options: RECORD_TYPES.map(type => ({ value: type, label: type })),
                onChange: next => { const found = RECORD_TYPES.find(type => type === next); if (found) set({ recordType: found }); } }))),
        text(t(`${K}.expectedAnswer`, 'Expected answer'), draft.expectedAnswer, value => set({ expectedAnswer: value }), {
            monospace: true, required: false, placeholder: '203.0.113.10',
            description: t(`${K}.expectedAnswer.hint`, 'Leave empty to only check that the name resolves.'), testID: 'health-setup-expected-answer' }),
        columns('cadence', 2, ...cadence),
    ] : draft.kind === 'heartbeat' ? [
        h(Text, { key: 'about', tone: 'secondary', value: t(`${K}.heartbeat.about`,
            'After you add the check, Happier gives your job an address to ping. A missed ping counts as a failure.') }),
        columns('cadence', 3, cadence[0]!,
            choice(t(`${K}.grace`, 'Grace'), draft.graceMs, GRACE, graceMs => set({ graceMs }), 'health-setup-grace'), cadence[1]!),
    ] : [
        text(t(`${K}.endpoint`, 'Endpoint'), draft.endpoint, value => set({ endpoint: value }), { monospace: true, url: true,
            placeholder: draft.kind === 'certificate' ? 'https://shop.example.com' : 'https://status.example.com',
            description: hostHint, ...(issues.endpoint ? { issue: issues.endpoint } : {}), testID: 'health-setup-endpoint' }),
        refusal,
        columns('cadence', 3,
            text(t(`${K}.expectStatus`, 'Expect status'), draft.expectStatus, value => set({ expectStatus: value }), {
                numeric: true, ...(issues.expectStatus ? { issue: issues.expectStatus } : {}), testID: 'health-setup-expect-status' }),
            ...cadence),
        ...(draft.kind === 'http' ? [text(t(`${K}.keyword`, 'Page contains'), draft.keyword, value => set({ keyword: value }), {
            required: false, placeholder: 'All systems operational', testID: 'health-setup-keyword' })] : []),
    ];

    return h(Stack, { gap: 'large', testID: 'health-setup-form' },
        h(SelectionTiles<HealthCheckKindV1>, { accessibilityLabel: t(`${K}.kind`, 'Kind of check'), testID: 'health-setup-kind',
            value: draft.kind, onChange: kind => set({ kind }), maximumColumns: 3, minimumColumns: 2,
            options: KINDS.map(kind => ({ id: kind.id, icon: kind.icon, title: kind.title, titleKey: `${K}.kind.${kind.id}`,
                subtitle: kind.subtitle, subtitleKey: `${K}.kind.${kind.id}.subtitle` })) }),
        ...fields,
        refusedSave ? h(Text, { tone: 'danger', value: t(`${K}.saveRefused`, 'This check can’t be added right now. Your entries are kept here.') }) : null,
        h(Row, { justify: 'flex-end' }, h(Button, { title: t(`${K}.add`, 'Add check'), variant: 'primary', disabled: !canAdd,
            busy: saving, testID: 'health-setup-add',
            onPress: async () => {
                if (!candidate.success) return;
                setSaving(true);
                try {
                    await host.settleEphemeralInput({ kind: 'completed', input: candidate.data }, { signal: props.signal });
                } catch {
                    setRefusedSave(true);
                } finally {
                    setSaving(false);
                }
            } })));
}

function HealthCheckSetupSurface(context: RenderContext): ReactElement {
    const launch = readLaunch(context.launchInput);
    if (!launch || launch.draft.subject === undefined) {
        return h(Text, { valueKey: `${K}.unavailable`, fallback: 'Open Add check from a watched service to set up its check.' });
    }
    return h(HealthCheckSetupForm, { subject: launch.draft.subject, existing: launch.draft.checks ?? [],
        ...(launch.observerMachineId ? { observerMachineId: launch.observerMachineId } : {}), signal: context.signal });
}

export const renderSurface = defineUiSurface(HealthCheckSetupSurface);
