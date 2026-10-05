import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { buildUniversalSearchSections } from '@/components/appShell/search/buildUniversalSearchSections';
import type { UniversalSearchResult } from '@/components/appShell/search/universalSearchResult';
import { SelectionList } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';

const noop = () => {};
const SCOPE = { serverId: 'dev', machineId: 'dev-machine', rootPath: '/repo' };

function fileTarget(path: string, line?: number) {
    return {
        kind: 'workspaceFile' as const, scope: SCOPE, path, workspaceRefId: null, sessionId: null, serverId: 'dev', accountId: 'dev',
        ...(line ? { anchor: { kind: 'fileLine' as const, startLine: line } } : {}),
    };
}

const HITS = [
    { path: 'apps/ui/sources/components/settings/SettingsModal.tsx', line: 23, text: '    const key = useSettingsRouteKey(route);' },
    { path: 'apps/ui/sources/components/settings/useSettingsRouteKey.ts', line: 9, text: 'export function useSettingsRouteKey(route: SettingsRoute) {' },
    { path: 'apps/ui/sources/components/settings/SettingsModal.test.tsx', line: 41, text: "    it('keeps the routeKey across a resize', () => {" },
].map((hit) => ({ ...hit, column16: hit.text.toLowerCase().indexOf('routekey') + 1 }));

const CONTENT: UniversalSearchResult[] = HITS.map((hit) => ({
    id: `${hit.path}:${hit.line}:${hit.column16}`, sourceId: 'fileContent', scopeKey: 'dev', kind: 'workspaceFile',
    title: hit.path, subtitle: `${hit.path}:${hit.line}`,
    fileContent: { path: hit.path, line: hit.line, column16: hit.column16, length16: 8, text: hit.text, before: [], after: [] },
    target: fileTarget(hit.path, hit.line),
}));

const FILES: UniversalSearchResult[] = [
    { id: 'f1', sourceId: 'files', scopeKey: 'dev', kind: 'workspaceFile', title: 'useSettingsRouteKey.ts', subtitle: 'apps/ui/sources/components/settings', target: fileTarget('apps/ui/sources/components/settings/useSettingsRouteKey.ts') },
    { id: 'f2', sourceId: 'files', scopeKey: 'dev', kind: 'workspaceFile', title: 'SettingsModal.tsx', subtitle: 'apps/ui/sources/components/settings', target: fileTarget('apps/ui/sources/components/settings/SettingsModal.tsx', 23) },
];

/** Dev specimen of Search's Files and Text in files rows (Find lab `fsearch` G1) through the real section builder. */
export function SearchTextInFilesSpecimen() {
    const sections = React.useMemo(() => buildUniversalSearchSections({
        query: 'routeKey',
        commands: [], sessions: [], projects: [], pluginSections: [],
        searchSettingsPages: () => [],
        transcript: { status: 'absent' }, commits: { status: 'absent' },
        files: { status: 'ready', resolverKey: 'dev-files', resolve: async () => FILES },
        fileContent: { status: 'ready', resolverKey: 'dev-content', resolve: async () => ({ results: CONTENT, hasMore: true }) },
        onCommitResult: noop,
    }), []);
    const rootStep = React.useMemo(() => ({ id: 'dev-search', sections }), [sections]);
    return (
        <View style={styles.cell} testID="dev-find-search">
            <Text style={styles.cellTitle}>G1 · Text in files</Text>
            <Text style={styles.cellDescription}>Files, then each hit as path:line with its line in mono and the match marked.</Text>
            <View style={styles.panel}>
                <SelectionList rootStep={rootStep} selectionMark="enter" inputValue="routeKey" onChangeInputValue={noop} onSelect={noop} onRequestClose={noop} fillAvailableSpace />
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    cell: { marginTop: 28, gap: 4, maxWidth: 900 },
    cellTitle: { fontSize: 13, fontWeight: '600', color: theme.colors.text.primary },
    cellDescription: { fontSize: 12.5, lineHeight: 17, color: theme.colors.text.secondary, marginBottom: 6 },
    panel: {
        height: 520,
        overflow: 'hidden',
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
}));
