import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { Typography } from '@/constants/Typography';

import { SessionBoardDeclarativeContent } from '@/components/sessions/board/SessionBoardDeclarativeContent';
import { Text } from '@/components/ui/text/Text';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';

import type { WidgetSpecimenFrames } from './widgetSpecimenTypes';

/**
 * The native data nodes (lab `dashboards` ddata DP/DPp) at static props: frozen values through the
 * one declarative renderer and the shared frame — exactly what a posted snapshot or a widget body
 * draws once its read arrives. Live reads cannot run on a dev page.
 */

const SIGNUPS = [['Thu', 142], ['Fri', 168], ['Sat', 151], ['Sun', 190], ['Mon', 214], ['Tue', 236], ['Wed', 183]] as const;

const SIGNUPS_DOCUMENT = { version: 1, root: { kind: 'stack', children: [
    { kind: 'metric', label: 'Signups this week', data: { kind: 'value', value: 1284 }, value: { path: [], type: 'number' } },
    { kind: 'chart', label: 'Signups per day', style: 'bar', rows: [], data: { kind: 'value', value: SIGNUPS.map(([x, y]) => ({ x, y })) },
        x: { path: ['x'], type: 'string' }, y: { path: ['y'], type: 'number' } },
] } };

const FUNNEL_DOCUMENT = { version: 1, root: { kind: 'rows', label: 'Onboarding funnel', rows: [], data: { kind: 'value', value: [
    { c0: 'Signed up', c1: 1284 }, { c0: 'Paired a machine', c1: 812 }, { c0: 'Started a session', c1: 655 }, { c0: 'Came back on day 2', c1: 402 },
] }, columns: [
    { label: 'Step', field: { path: ['c0'], type: 'string' } },
    { label: 'People', field: { path: ['c1'], type: 'number' }, proportion: true },
] } };

const PEOPLE_DOCUMENT = { version: 1, root: { kind: 'table', label: 'Newest people', rows: [], data: { kind: 'value', value: [
    { c0: 'Mira Kovač', c1: 'Team', c2: 'Paired 2 machines', c3: '10:38' },
    { c0: 'Jonas Weber', c1: 'Free', c2: 'Started a session', c3: '10:21' },
    { c0: 'Aiko Tanaka', c1: 'Free', c2: 'Signed up', c3: '10:02' },
] }, columns: [
    { label: 'Person', field: { path: ['c0'], type: 'string' } },
    { label: 'Plan', field: { path: ['c1'], type: 'string' }, priority: 'secondary' },
    { label: 'Got to', field: { path: ['c2'], type: 'string' } },
    { label: 'Joined', field: { path: ['c3'], type: 'string' } },
] } };

const ERROR_RATE_DOCUMENT = { version: 1, root: { kind: 'chart', label: 'Error rate', style: 'line', rows: [], data: { kind: 'value', value: [
    3.1, 2.8, 3.4, 2.2, 1.9, 2.4, 1.6, 1.4, 1.8, 1.2,
].map((y, index) => ({ x: index === 9 ? 'today' : index === 0 ? '10 days ago' : `${10 - index} days ago`, y })) },
    x: { path: ['x'], type: 'string' }, y: { path: ['y'], type: 'number' } } };

function DataCard(props: Readonly<{ title: string; source: string; meta?: string; document: unknown; snapshot?: boolean; testID: string }>) {
    return (
        <WidgetFrame
            testID={props.testID}
            frameStyle="card"
            placement="board"
            mark="squares-four"
            title={props.title}
            source={props.source}
            {...(props.meta ? { meta: <Text style={stylesheet.meta}>{props.meta}</Text> } : {})}
            body={{ kind: 'content', children: (
                <SessionBoardDeclarativeContent document={props.document} {...(props.snapshot ? { snapshot: true } : {})} testID={`${props.testID}.document`} />
            ) }}
        />
    );
}

function DataColumns(props: Readonly<{ phone: boolean }>) {
    return (
        <View style={props.phone ? stylesheet.phone : stylesheet.columns}>
            <View style={props.phone ? null : stylesheet.column}>
                <DataCard testID="dp.signups" title="Signups this week" source="analytics replica" meta="10:42" document={SIGNUPS_DOCUMENT} />
            </View>
            <View style={props.phone ? null : stylesheet.column}>
                <DataCard testID="dp.funnel" title="Onboarding funnel" source="analytics replica" meta="Last 7 days" document={FUNNEL_DOCUMENT} />
                <DataCard testID="dp.people" title="Newest people" source="analytics replica" meta="10:42" document={PEOPLE_DOCUMENT} />
            </View>
            <View style={props.phone ? null : stylesheet.column}>
                <DataCard testID="dp.errors" title="Error rate" source="Sentry" document={ERROR_RATE_DOCUMENT} />
                <DataCard testID="dp.snapshot" title="Signups this week" source="Snapshot" meta="as of 10:42" document={SIGNUPS_DOCUMENT} snapshot />
            </View>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    columns: { width: 1380, flexDirection: 'row', gap: 24, alignItems: 'flex-start' },
    column: { flex: 1, gap: 16 },
    phone: { width: 390, gap: 12, paddingHorizontal: 16 },
    meta: { ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.tertiary },
}));

export const DATA_SPECIMEN_FRAMES: WidgetSpecimenFrames = {
    DP: ({ phone }) => <DataColumns phone={phone} />,
    DPp: () => <DataColumns phone />,
};
