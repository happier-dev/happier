import * as React from 'react';
import { View } from 'react-native';
import {
    Badge,
    Button,
    Collection,
    Heading,
    Icon,
    Row,
    Select,
    Stack,
    Step,
    Tabs,
    Text,
    useHappierCollection,
    usePluginTheme,
    type CollectionAnatomy,
    type TextTone,
} from '@happier-dev/plugin-ui';
import { HAPPIER_TONE_COLOR_TOKEN, HappierStatusDot } from '@happier-dev/plugin-ui/presentation';

/**
 * Dev-only preview of the plugin-ui Collection (`/dev/plugin-ui`): the PRs & Issues table at rest, peek, the
 * table → split shared-element move, the board and grid with their drawer, and the pushed detail on a phone, over
 * the design lab's own entries
 * (`.happier/design-lab/prs-and-issues/c7-merged.html`). It exists so the transition can be checked live against
 * the lab without a configured source; it renders only public plugin-ui API, inside the demo plugin surface.
 */
type PreviewEntry = Readonly<{
    id: string;
    group: 'needs' | 'agent' | 'review' | 'rest';
    kind: 'pr' | 'issue' | 'error';
    title: string;
    where: string;
    reason: Readonly<{ label: string; tone: TextTone }> | null;
    signal: Readonly<{ label: string; tone: TextTone }> | null;
    agent: string | null;
    age: string;
    summary: string;
}>;

const ENTRIES: readonly PreviewEntry[] = [
    { id: 'pr2481', group: 'needs', kind: 'pr', title: 'Retry idempotent payment intents on 409 conflicts', where: 'payments-api #2481', reason: { label: 'Review requested', tone: 'warning' }, signal: { label: 'Checks passed', tone: 'success' }, agent: 'Working', age: '18m', summary: 'Stripe returns 409 when two confirms race on the same payment intent. This retries idempotent confirms once with the original key.' },
    { id: 'pr2476', group: 'needs', kind: 'pr', title: 'Move cart totals to server-side rounding', where: 'checkout-web #2476', reason: { label: 'Codex needs you', tone: 'warning' }, signal: { label: '2 failing', tone: 'danger' }, agent: 'Needs you', age: '42m', summary: 'Cart totals were rounded on the client, which drifts from the server by a cent on some tax combinations.' },
    { id: 'err1', group: 'needs', kind: 'error', title: "TypeError: Cannot read properties of undefined (reading 'currency')", where: 'checkout-web', reason: { label: 'Escalating', tone: 'danger' }, signal: { label: '318 users', tone: 'danger' }, agent: 'Ready for review', age: '2h', summary: 'CartSummary.tsx reads currency before the pricing response resolves.' },
    { id: 'pr2470', group: 'needs', kind: 'pr', title: 'Add Stripe webhook replay tool for support', where: 'payments-api #2470', reason: { label: 'Ready to merge', tone: 'success' }, signal: { label: 'Checks passed', tone: 'success' }, agent: null, age: '1d', summary: 'A support-only tool to replay a webhook delivery by event id.' },
    { id: 'mr88', group: 'needs', kind: 'pr', title: 'Pin Terraform AWS provider to 5.62 across modules', where: 'infra-modules !88', reason: { label: 'Mentioned', tone: 'warning' }, signal: { label: '2 running', tone: 'warning' }, agent: null, age: '7h', summary: 'Pins the provider so plans stop drifting between machines.' },
    { id: 'is903', group: 'agent', kind: 'issue', title: 'Checkout button stays disabled after Apple Pay is cancelled', where: 'checkout-web #903', reason: { label: 'Assigned to you', tone: 'warning' }, signal: null, agent: 'Working', age: '3h', summary: 'Cancelling the Apple Pay sheet leaves the button disabled until reload.' },
    { id: 'pr1193', group: 'review', kind: 'pr', title: 'Android: stop double-firing push notifications on resume', where: 'mobile #1193', reason: { label: 'Waiting on Priya', tone: 'secondary' }, signal: { label: 'Checks passed', tone: 'success' }, agent: null, age: '5h', summary: 'Resume re-registered the listener, so pushes fired twice.' },
    { id: 'pr2459', group: 'review', kind: 'pr', title: 'Batch settlement export to S3', where: 'payments-api #2459', reason: { label: 'Waiting on Mara', tone: 'secondary' }, signal: { label: 'Checks passed', tone: 'success' }, agent: null, age: '1d', summary: 'Exports daily settlement batches to S3 for finance.' },
    { id: 'ph1', group: 'rest', kind: 'error', title: 'Unhandled promise rejection in onboarding step 3', where: 'tidewater-app', reason: { label: 'New in 4.12.0', tone: 'warning' }, signal: { label: '57 users', tone: 'danger' }, agent: null, age: '6h', summary: 'A rejected profile fetch is never caught on step 3.' },
    { id: 'is912', group: 'rest', kind: 'issue', title: 'Dark mode: date picker text unreadable on Android', where: 'mobile #912', reason: null, signal: { label: 'bug, android', tone: 'secondary' }, agent: null, age: '1d', summary: 'The picker keeps its light text colour in dark mode.' },
    { id: 'ab4417', group: 'rest', kind: 'issue', title: 'Rotate staging service principals before 1 October', where: 'Ops AB#4417', reason: null, signal: { label: 'ops', tone: 'secondary' }, agent: null, age: '2d', summary: 'The staging principals expire on 1 October.' },
    { id: 'err2', group: 'rest', kind: 'error', title: 'PaymentIntentConflict: 409 on confirm', where: 'payments-api', reason: null, signal: { label: '41 users', tone: 'danger' }, agent: null, age: '2d', summary: 'The conflict the retry PR fixes.' },
];

const GROUPS = {
    axis: [
        { key: 'needs', title: 'Needs you', description: 'You act next' },
        { key: 'agent', title: 'With an agent', description: 'A linked session is working' },
        { key: 'review', title: 'In review', description: 'Waiting on someone else' },
        { key: 'rest', title: 'Everything else', description: 'Nobody is waiting on you' },
    ],
    groupOf: (entry: PreviewEntry) => entry.group,
};

const keyOf = (entry: PreviewEntry) => entry.id;

/** The PRs & Issues cell state (Triage `list/rows.tsx`): a tone mark beside a quiet word; secondary facts stay unmarked. */
function CellState(props: Readonly<{ tone: TextTone; label: string; live?: boolean }>): React.ReactElement {
    const theme = usePluginTheme();
    return (
        <Row gap="xsmall" align="center" style={{ minWidth: 0, maxWidth: '100%' }}>
            {props.tone === 'secondary' ? null : <HappierStatusDot color={theme.colors[HAPPIER_TONE_COLOR_TOKEN[props.tone]]} isPulsing={props.live === true} />}
            <Stack style={{ flexShrink: 1, minWidth: 0 }}><Text variant="caption" tone="secondary" value={props.label} numberOfLines={1} /></Stack>
        </Row>
    );
}

const AGENT_TONES: Readonly<Record<string, TextTone>> = { Working: 'info', 'Needs you': 'warning', 'Ready for review': 'secondary' };

function useAnatomy(open: (key: string) => void): CollectionAnatomy<PreviewEntry> {
    return React.useMemo(() => ({
        glyph: (entry) => (
            <Icon
                name={entry.kind === 'pr' ? 'change-open' : entry.kind === 'issue' ? 'issue' : 'bug'}
                size="small"
                tone={entry.kind === 'error' ? 'danger' : 'success'}
            />
        ),
        title: (entry) => entry.title,
        where: (entry) => entry.where,
        reason: (entry) => (entry.reason === null ? null : entry.reason.tone === 'secondary' ? (
            <Text variant="caption" tone="secondary" value={entry.reason.label} numberOfLines={1} />
        ) : <Badge variant="tinted" tone={entry.reason.tone} value={entry.reason.label} />),
        signal: (entry) => (entry.signal === null ? null : <CellState tone={entry.signal.tone} label={entry.signal.label} />),
        agent: (entry) => (entry.agent === null ? null : (
            <CellState tone={AGENT_TONES[entry.agent] ?? 'secondary'} label={entry.agent} live={entry.agent === 'Working'} />
        )),
        age: (entry) => entry.age,
        description: (entry) => entry.summary,
        action: () => <Button title="Pin" variant="plain" size="small" onPress={() => undefined} />,
        peek: (entry) => (
            <Stack gap="small">
                <Text variant="body" tone="secondary" value={entry.summary} numberOfLines={3} />
                <Row gap="small">
                    <Button title="Open" variant="primary" size="small" onPress={() => { open(entry.id); }} />
                    <Button title="Pin" variant="secondary" size="small" onPress={() => undefined} />
                </Row>
            </Stack>
        ),
        accessibilityLabel: (entry) => entry.title,
        testID: (entry) => `collection-preview-row:${entry.id}`,
        columnTitles: { title: 'Entry', where: 'Where', reason: 'Why it’s here', signal: 'Signal', agent: 'Agent', age: 'Age' },
    }), [open]);
}

const NO_ENTRIES: readonly PreviewEntry[] = [];

export function CollectionPreviewSample(): React.ReactElement {
    const [openKey, setOpenKey] = React.useState<string | null>(null);
    const [presentation, setPresentation] = React.useState<'table' | 'board' | 'grid'>('table');
    // The first window still reading: no rows yet, so each view holds its geometry with skeletons.
    const [reading, setReading] = React.useState(false);
    const model = useHappierCollection({
        items: reading ? NO_ENTRIES : ENTRIES,
        keyOf,
        groups: GROUPS,
        openKey,
        onOpenChange: setOpenKey,
        expandable: true,
        window: { kind: 'partial', continuations: [{ key: 'ado', label: 'Load more from Azure DevOps', load: () => undefined }] },
    });
    const anatomy = useAnatomy(setOpenKey);
    const opened = ENTRIES.find((entry) => entry.id === openKey) ?? null;
    return (
        <View testID="dev-collection-preview" style={{ height: 760 }}>
            <Row gap="medium" style={{ paddingBottom: 12 }}>
                <Select
                    label="View"
                    presentation="segmented"
                    value={presentation}
                    options={[
                        { value: 'table', label: 'List' },
                        { value: 'board', label: 'Board' },
                        { value: 'grid', label: 'Grid' },
                    ]}
                    onChange={(value) => {
                        if (value === 'table' || value === 'board' || value === 'grid') setPresentation(value);
                    }}
                    testID="dev-collection-view"
                />
                <Select
                    label="Data"
                    presentation="segmented"
                    value={reading ? 'reading' : 'loaded'}
                    options={[
                        { value: 'loaded', label: 'Loaded' },
                        { value: 'reading', label: 'Reading' },
                    ]}
                    onChange={(value) => { setReading(value === 'reading'); }}
                    testID="dev-collection-data"
                />
            </Row>
            <Collection
                model={model}
                anatomy={anatomy}
                accessibilityLabel="PRs & Issues"
                presentation={presentation}
                loading={reading}
                detail="auto"
                minListWidth={320}
                minDetailWidth={520}
                preferredListRatio={0.37}
                windowStatement={['12 loaded', 'complete for GitHub, GitLab, Sentry, PostHog', 'Azure DevOps has more']}
                testID="dev-collection"
                renderDetail={() => (opened === null ? null : (
                    <Stack gap="medium" style={{ padding: 24 }}>
                        <Row justify="space-between" align="center">
                            <Text variant="caption" tone="secondary" value={opened.where} />
                            <Button title="Close" variant="plain" size="small" onPress={() => { setOpenKey(null); }} />
                        </Row>
                        <Heading level={1} value={opened.title} />
                        <PreviewDetailTabs entry={opened} />
                    </Stack>
                ))}
            />
        </View>
    );
}

/** The lab's detail chrome over the shared primitives: the tab strip and the numbered story rail (c7 Overview). */
function PreviewDetailTabs(props: Readonly<{ entry: PreviewEntry }>): React.ReactElement {
    const [tab, setTab] = React.useState('overview');
    return (
        <Tabs value={tab} onValueChange={setTab} ariaLabel="Entry sections" testID="dev-collection-detail-tabs">
            <Tabs.Item value="overview" title="Overview">
                <Stack gap="large">
                    <Step marker={{ kind: 'number', value: 1 }} title="The ask">
                        <Text variant="reading" tone="neutral" value={props.entry.summary} />
                    </Step>
                    <Step marker={{ kind: 'number', value: 2 }} title="What changed" trailing={<Text variant="caption" tone="secondary" value="+388 −142 in 17 files" />}>
                        <Text variant="reading" tone="secondary" value="src/cart/totals.ts, services/pricing/round.ts and 15 more" />
                    </Step>
                    <Step marker={{ kind: 'state', state: 'failed', label: '2 failing' }} title="Checks" trailing={<Text variant="caption" tone="danger" value="2 failing" />}>
                        <Text variant="reading" tone="secondary" value="e2e / webkit rounds VAT on mixed baskets: expected 12.30, received 12.29" />
                    </Step>
                    <Step marker={{ kind: 'state', state: 'passed', label: 'Passed' }} title="Review" />
                </Stack>
            </Tabs.Item>
            <Tabs.Item value="activity" title="Activity" />
            <Tabs.Item value="files" title="Files" badge="17" />
            <Tabs.Item value="checks" title="Checks" />
        </Tabs>
    );
}
