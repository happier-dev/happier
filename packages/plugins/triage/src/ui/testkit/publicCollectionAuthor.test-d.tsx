/** Compile-only author fixture for plugins/ui/react-native.mdx; public package imports only. */
import * as React from 'react';
import { Button, Collection, Icon, Row, Stack, Step, Tabs, Text } from '@happier-dev/plugin-ui';
import {
    HappierDisclosure,
    HappierPressable,
    HAPPIER_INSTANT_DISCLOSURE_MOTION,
    useHappierCollection,
    type HappierCollectionPresentation,
} from '@happier-dev/plugin-ui/presentation';
import { useHappierUiAccessibility } from '@happier-dev/plugin-ui/environment';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import {
    TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_REF_V1,
    TRIAGE_SET_FIX_PULL_REQUEST_ACTION_REF_V1,
    TriageReadFixPullRequestsResultV1Schema,
    TriageSetFixPullRequestResultV1Schema,
    type TriageEntryRefV1,
} from '@happier-dev/triage-protocol/v1';

type Item = { id: string; title: string; summary: string };
const keyOf = (item: Item) => item.id;

function ItemDetail({ item, headerHosted, close }: {
    item: Item; headerHosted: boolean; close(): void;
}) {
    const [tab, setTab] = React.useState('overview');
    const [expanded, setExpanded] = React.useState(false);
    const { reducedMotion } = useHappierUiAccessibility();
    return (
        <Stack>
            {!headerHosted && <Row><Text value={item.title} variant="title" /><Button title="Close" onPress={close} /></Row>}
            <Tabs value={tab} onValueChange={setTab} ariaLabel="Item detail">
                <Tabs.Item value="overview" title="Overview">
                    <Step marker={{ kind: 'number', value: 1 }} title="The request">
                        <Text value={item.summary} selectable />
                    </Step>
                    <HappierDisclosure expanded={expanded} onExpandedChange={setExpanded}
                        reducedMotion={reducedMotion} motion={HAPPIER_INSTANT_DISCLOSURE_MOTION}
                        showDivider={false}
                        header={({ headerProps }) => (
                            <HappierPressable {...headerProps}><Text value="More context" /></HappierPressable>
                        )}>
                        <Text value="Additional facts from this item's data owner." selectable />
                    </HappierDisclosure>
                </Tabs.Item>
                <Tabs.Item value="activity" title="Activity">
                    <Text value="The source's activity belongs here." />
                </Tabs.Item>
            </Tabs>
        </Stack>
    );
}

export function ItemsPage({ items, openKey, onOpenChange }: {
    items: readonly Item[]; openKey: string | null; onOpenChange(key: string | null): void;
}) {
    const [presentation, setPresentation] = React.useState<HappierCollectionPresentation>('table');
    const model = useHappierCollection({ items, keyOf, openKey, onOpenChange, expandable: true });
    return (
        <Stack style={{ flex: 1 }}>
            <Row>
                <Button title="Table" onPress={() => setPresentation('table')} />
                <Button title="Board" onPress={() => setPresentation('board')} />
            </Row>
            <Collection model={model} presentation={presentation} detail="auto" accessibilityLabel="Items"
                minListWidth={280} minDetailWidth={420} preferredListRatio={0.4}
                anatomy={{
                    glyph: () => <Icon name="file" />,
                    title: (item) => item.title, accessibilityLabel: (item) => item.title,
                    columnTitles: { title: 'Item' }, peek: (item) => <Text value={item.summary} />,
                }}
                detailHeader={(key) => ({ title: items.find((item) => item.id === key)?.title ?? 'Item' })}
                renderDetail={(key, { headerHosted }) => {
                    const item = items.find((candidate) => candidate.id === key);
                    return item ? <ItemDetail item={item} headerHosted={headerHosted} close={model.actions.close} /> : null;
                }}
            />
        </Stack>
    );
}

/** Compile the public fix-link recipe from plugins/ui/index.mdx through the real Host API. */
export async function linkFixPullRequest(
    host: PluginUiHostApi,
    entryRef: TriageEntryRefV1,
    issueDisplay: { title: string; scopeLabel: string },
    pullRequest: { entryRef: TriageEntryRefV1; display: { title: string; scopeLabel: string } },
    signal?: AbortSignal,
) {
    const written = TriageSetFixPullRequestResultV1Schema.parse(await host.executeAction(
        TRIAGE_SET_FIX_PULL_REQUEST_ACTION_REF_V1,
        { v: 1, linked: true, entryRef, displayAtMark: issueDisplay,
            fixPullRequest: pullRequest.entryRef, displayAtLink: pullRequest.display },
        { signal },
    ));
    if (written.status !== 'linked') return { written };
    const resolved = TriageReadFixPullRequestsResultV1Schema.parse(await host.executeAction(
        TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_REF_V1, { v: 1, entryRef }, { signal },
    ));
    return { written, resolved };
}
