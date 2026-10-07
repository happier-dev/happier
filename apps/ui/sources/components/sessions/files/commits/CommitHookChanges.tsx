import * as React from 'react';
import { View } from 'react-native';
import { classifyScmChangePath } from '@happier-dev/protocol/scm/comparison';
import type { ScmDiffCommitResponse } from '@happier-dev/protocol/scm';

import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { buildDiffFileEntries } from '@/components/ui/code/model/diff/diffViewModel';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import type { CommitPlanOutcome, CommitProposalChange } from './commitProposal';
import { CommitChangeRow } from './CommitProposalParts';

export type ReadCommitHookDiff = (trees: Readonly<{ beforeTreeOid: string; afterTreeOid: string }>) => Promise<ScmDiffCommitResponse>;
type HookOutcome = Extract<CommitPlanOutcome, { kind: 'hookChanged' }>;
type HookFiles = NonNullable<ScmDiffCommitResponse['files']>;
export type CommitHookEvidence = Readonly<{
    key: string | null;
    state: 'loading' | 'unavailable' | 'ready';
    files: HookFiles;
}>;

/** The recorded trees, not a fresh working-tree comparison, are the only inspection authority. */
export function useCommitHookEvidence(outcome: HookOutcome | null, read: ReadCommitHookDiff | undefined): CommitHookEvidence {
    const beforeTreeOid = outcome?.beforeTreeOid;
    const afterTreeOid = outcome?.afterTreeOid;
    const key = outcome ? `${beforeTreeOid}:${afterTreeOid}` : null;
    const pathsKey = JSON.stringify(outcome?.paths ?? []);
    const [loaded, setLoaded] = React.useState<CommitHookEvidence & Readonly<{ read?: ReadCommitHookDiff; pathsKey?: string }>>({ key: null, state: 'unavailable', files: [] });
    React.useEffect(() => {
        if (!key || !beforeTreeOid || !afterTreeOid || !read) return;
        let current = true;
        setLoaded({ key, read, pathsKey, state: 'loading', files: [] });
        void read({ beforeTreeOid, afterTreeOid }).then((response) => {
            if (!current) return;
            const paths = new Set(outcome?.paths);
            const files = response.files;
            const exact = response.success && response.beforeTreeOid === beforeTreeOid && response.afterTreeOid === afterTreeOid
                && files !== undefined && files.length === paths.size
                && new Set(files.map((file) => file.path)).size === paths.size
                && files.every((file) => paths.has(file.path) && file.unifiedDiff.length > 0);
            setLoaded({ key, read, pathsKey, state: exact ? 'ready' : 'unavailable', files: exact && files ? files : [] });
        }).catch(() => { if (current) setLoaded({ key, read, pathsKey, state: 'unavailable', files: [] }); });
        return () => { current = false; };
    }, [key, beforeTreeOid, afterTreeOid, pathsKey, read]);
    // A second pause or a different bound reader never gets even one frame of the previous evidence.
    if (!key || !read) return { key, state: 'unavailable', files: [] };
    return loaded.key === key && loaded.read === read && loaded.pathsKey === pathsKey ? loaded : { key, state: 'loading', files: [] };
}

export function CommitHookChanges(props: Readonly<{ evidence: CommitHookEvidence; groupNumber: number; phone: boolean }>) {
    const { evidence } = props;
    const [opened, setOpened] = React.useState<Readonly<{ key: string | null; path: string }> | null>(null);
    const rows = React.useMemo(() => evidence.files.map((file) => {
        const stats = buildDiffFileEntries([{ filePath: file.path, unifiedDiff: file.unifiedDiff }])[0];
        const change: CommitProposalChange = { key: file.path, path: file.path, changeKind: file.changeKind,
            added: stats?.added ?? 0, removed: stats?.removed ?? 0, changeRefs: [], part: null,
            ...classifyScmChangePath(file.path), hookChanged: true };
        return { file, change };
    }), [evidence.files]);
    if (evidence.state !== 'ready') return (
        <SurfaceStateCard testID={evidence.state === 'loading' ? 'commit-hook-evidence-loading' : 'commit-hook-evidence-unavailable'}
            size="line" kind={evidence.state === 'loading' ? 'loading' : 'unavailable'}
            title={evidence.state === 'loading' ? t('common.loading') : t('common.unavailable')} />
    );
    return <View>
        {rows.map(({ file, change }) => {
            const expanded = opened?.key === evidence.key && opened.path === file.path;
            return <View key={file.path}>
                <CommitChangeRow change={change} groupNumber={props.groupNumber} choices={null} focused={expanded} phone={props.phone}
                    inspect={{ expanded, onPress: () => setOpened(expanded ? null : { key: evidence.key, path: file.path }) }} />
                {expanded ? <DiffViewer testID={`commit-hook-diff:${file.path}`} mode="unified" filePath={file.path}
                    unifiedDiff={file.unifiedDiff} showLineNumbers showPrefix wrapLines={props.phone}
                    presentationStyleOverride="unified" virtualized={false} /> : null}
            </View>;
        })}
    </View>;
}
