import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    EmptyState as PluginEmptyState,
    Item as PluginItem,
    ItemGroup as PluginItemGroup,
    PageHeader as PluginPageHeader,
    Select as PluginSelect,
    SelectionTiles as PluginSelectionTiles,
    Stack as PluginStack,
    TextField as PluginTextField,
    Toggle as PluginToggle,
    Banner as PluginBanner,
    Progress as PluginProgress,
    SetupSteps as PluginSetupSteps,
} from '@happier-dev/plugin-ui';

import { EmptyState } from '@/components/ui/empty/EmptyState';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Switch } from '@/components/ui/forms/Switch';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { SetupSteps } from '@/components/ui/setupBlocks/SetupSteps';

/**
 * Dev-only side-by-side of the configuration-page anatomy (`/dev/plugin-ui`, configuration-surfaces U9):
 * the same settings page composed once from Happier core's owners and once from the public plugin
 * components. Both halves render through the same shared presentation owners (`HappierPageHeader`,
 * `HappierPageSectionHeader`, the page metrics and type scale), so any visual difference between the
 * two columns is a defect. The plugin half is mounted as a real plugin surface by the dev screen.
 */
const COPY = {
    title: 'Review bot',
    description: 'Reviews pull requests and posts its findings to your sessions.',
    meta: [
        { key: 'version', text: 'v1.4.0' },
        { key: 'machine', text: 'Installed on this computer' },
    ],
    reviews: {
        title: 'Reviews',
        description: 'When the bot reviews, and how much it reads.',
        newPr: { title: 'Review new pull requests', subtitle: 'Start a review when a pull request opens.' },
        channel: {
            title: 'Post findings to',
            options: [
                { id: 'session', label: 'The linked session' },
                { id: 'comment', label: 'A pull request comment' },
            ],
        },
        limit: { title: 'Files per review', subtitle: 'Larger pull requests are reviewed in parts.' },
        depth: {
            title: 'Depth',
            options: [
                { id: 'quick', label: 'Quick' },
                { id: 'thorough', label: 'Thorough' },
            ],
        },
    },
    layout: {
        title: 'Findings',
        rowTitle: 'Layout',
        description: 'How findings look in the session.',
        options: [
            { id: 'compact', title: 'Compact', lines: 1 },
            { id: 'detailed', title: 'Detailed', lines: 3 },
        ],
    },
    history: {
        title: 'History',
        description: 'The reviews the bot has posted.',
        empty: 'No reviews yet',
    },
} as const;

type Channel = 'session' | 'comment';
type Depth = 'quick' | 'thorough';
type Layout = 'compact' | 'detailed';

const SETUP_STEPS = [
    { key: 'connect', title: 'Connect your account', state: 'done' },
    { key: 'review', title: 'Start the first review', state: 'current', detail: 'Findings appear in the linked session.' },
] as const;

/** A finding row at static props: the preview both halves render for a layout tile. */
function FindingPreview(props: Readonly<{ lines: number }>) {
    return (
        <View style={styles.preview}>
            {Array.from({ length: props.lines }, (_, index) => (
                <View key={index} style={[styles.previewLine, index === 0 ? styles.previewLineStrong : null]} />
            ))}
        </View>
    );
}

function useSampleState() {
    const [reviewNew, setReviewNew] = React.useState(true);
    const [channel, setChannel] = React.useState<Channel>('session');
    const [depth, setDepth] = React.useState<Depth>('thorough');
    const [layout, setLayout] = React.useState<Layout>('detailed');
    const [limit, setLimit] = React.useState('40');
    return { reviewNew, setReviewNew, channel, setChannel, depth, setDepth, layout, setLayout, limit, setLimit };
}

export function CorePageAnatomySample() {
    const { theme } = useUnistyles();
    const state = useSampleState();
    const [channelOpen, setChannelOpen] = React.useState(false);
    return (
        <ListPresentationProvider value="page">
            <View style={styles.paper} testID="core-page-anatomy">
                <PageHeader
                    title={COPY.title}
                    description={COPY.description}
                    meta={COPY.meta}
                    alwaysShowTitle
                    testID="core-page-anatomy-header"
                />
                <AttentionBanner testID="core-page-anatomy-notice" title="Sign-in needs attention"
                    description="Reconnect the account to resume reviews." tone="warning" />
                <ItemGroup title="Setup" surface="none">
                    <MeterBar tone="neutral" fillFraction={0.5} height={8}
                        fillColor={theme.colors.button.primary.background} trackColor={theme.colors.button.primary.disabled}
                        progressAccessibilityLabel="Setup progress" testID="core-page-anatomy-progress" />
                    <SetupSteps testID="core-page-anatomy-steps" steps={SETUP_STEPS} />
                </ItemGroup>
                <ItemGroup title={COPY.reviews.title} description={COPY.reviews.description}>
                    <Item
                        title={COPY.reviews.newPr.title}
                        subtitle={COPY.reviews.newPr.subtitle}
                        showChevron={false}
                        rightElement={<Switch value={state.reviewNew} onValueChange={state.setReviewNew} />}
                    />
                    <DropdownMenu
                        open={channelOpen}
                        onOpenChange={setChannelOpen}
                        selectedId={state.channel}
                        items={COPY.reviews.channel.options.map((option) => ({ id: option.id, title: option.label }))}
                        onSelect={(id) => { state.setChannel(id as Channel); setChannelOpen(false); }}
                        itemTrigger={{ title: COPY.reviews.channel.title }}
                    />
                    <FieldValueItem
                        title={COPY.reviews.limit.title}
                        subtitle={COPY.reviews.limit.subtitle}
                        kind="integer"
                        value={state.limit}
                        onCommit={(draft) => { state.setLimit(draft); }}
                    />
                    <SegmentedChoiceItem
                        title={COPY.reviews.depth.title}
                        options={COPY.reviews.depth.options}
                        value={state.depth}
                        onChange={state.setDepth}
                    />
                </ItemGroup>
                <ItemGroup title={COPY.layout.title} description={COPY.layout.description}>
                    <Item
                        title={COPY.layout.rowTitle}
                        showChevron={false}
                        accessoryLayout="stacked"
                        rightElement={(
                            <SelectionTiles
                                variant="visual"
                                accessibilityLabel={COPY.layout.title}
                                value={state.layout}
                                onChange={(next) => { if (next) state.setLayout(next); }}
                                options={COPY.layout.options.map((option) => ({
                                    id: option.id,
                                    title: option.title,
                                    preview: <FindingPreview lines={option.lines} />,
                                }))}
                            />
                        )}
                    />
                </ItemGroup>
                <ItemGroup title={COPY.history.title} description={COPY.history.description}>
                    <EmptyState layout="line" title={COPY.history.empty} />
                </ItemGroup>
            </View>
        </ListPresentationProvider>
    );
}

/** The plugin half: public `@happier-dev/plugin-ui` components only. */
export function PluginPageAnatomySample() {
    const state = useSampleState();
    return (
        <PluginStack gap="none" testID="plugin-page-anatomy">
            <PluginPageHeader
                title={COPY.title}
                description={COPY.description}
                meta={COPY.meta}
                testID="plugin-page-anatomy-header"
            />
            <PluginItemGroup surface="none">
                <PluginBanner title="Sign-in needs attention" description="Reconnect the account to resume reviews."
                    tone="warning" testID="plugin-page-anatomy-notice" />
            </PluginItemGroup>
            <PluginItemGroup title="Setup" surface="none">
                <PluginProgress value={0.5} label="Setup progress" testID="plugin-page-anatomy-progress" />
                <PluginSetupSteps testID="plugin-page-anatomy-steps" steps={SETUP_STEPS} />
            </PluginItemGroup>
            <PluginItemGroup title={COPY.reviews.title} description={COPY.reviews.description}>
                <PluginItem
                    title={COPY.reviews.newPr.title}
                    subtitle={COPY.reviews.newPr.subtitle}
                    accessory={<PluginToggle label={COPY.reviews.newPr.title} value={state.reviewNew} onChange={state.setReviewNew} />}
                    accessoryOutsidePressable
                />
                <PluginItem
                    title={COPY.reviews.channel.title}
                    accessory={(
                        <PluginSelect
                            presentation="field"
                            label={COPY.reviews.channel.title}
                            value={state.channel}
                            onChange={(next) => state.setChannel(next as Channel)}
                            options={COPY.reviews.channel.options.map((option) => ({ value: option.id, label: option.label }))}
                        />
                    )}
                    accessoryOutsidePressable
                    accessoryWraps
                />
                <PluginItem
                    title={COPY.reviews.limit.title}
                    subtitle={COPY.reviews.limit.subtitle}
                    accessory={(
                        <PluginTextField
                            presentation="field"
                            kind="integer"
                            label={COPY.reviews.limit.title}
                            value={state.limit}
                            onChange={() => undefined}
                            onCommit={(draft) => { state.setLimit(draft); }}
                        />
                    )}
                    accessoryOutsidePressable
                    accessoryWraps
                />
                <PluginItem
                    title={COPY.reviews.depth.title}
                    accessory={(
                        <PluginSelect
                            presentation="segmented"
                            label={COPY.reviews.depth.title}
                            value={state.depth}
                            onChange={(next) => state.setDepth(next as Depth)}
                            options={COPY.reviews.depth.options.map((option) => ({ value: option.id, label: option.label }))}
                        />
                    )}
                    accessoryOutsidePressable
                    accessoryWraps
                />
            </PluginItemGroup>
            <PluginItemGroup title={COPY.layout.title} description={COPY.layout.description}>
                <PluginItem title={COPY.layout.rowTitle}>
                    <PluginSelectionTiles
                        variant="visual"
                        accessibilityLabel={COPY.layout.title}
                        value={state.layout}
                        onChange={(next) => { if (next) state.setLayout(next as Layout); }}
                        options={COPY.layout.options.map((option) => ({
                            id: option.id,
                            title: option.title,
                            preview: <FindingPreview lines={option.lines} />,
                        }))}
                    />
                </PluginItem>
            </PluginItemGroup>
            <PluginItemGroup title={COPY.history.title} description={COPY.history.description}>
                <PluginEmptyState layout="line" title={COPY.history.empty} />
            </PluginItemGroup>
        </PluginStack>
    );
}

const styles = StyleSheet.create((theme) => ({
    paper: {
        backgroundColor: theme.colors.surface.base,
        paddingBottom: 24,
    },
    preview: {
        width: 120,
        gap: 6,
        padding: 10,
    },
    previewLine: {
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.border.default,
    },
    previewLineStrong: {
        backgroundColor: theme.colors.text.secondary,
    },
}));
