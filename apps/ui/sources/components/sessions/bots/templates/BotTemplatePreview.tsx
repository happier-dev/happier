import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import type { BotTemplateContentV1, BotTemplateSkillV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { FileViewerBody } from '@/components/workspaces/files/file/FileViewerBody';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { t } from '@/text';

export type BotTemplatePreviewProps = Readonly<{
    content: BotTemplateContentV1;
    onDownloadFile?: (skillKey: string, path: string) => void;
}>;

type SkillFile = BotTemplateSkillV1['entries'][number];

/** Decode carried bytes only while the person is inspecting this file. */
export function BotTemplateFilePreview(props: Readonly<{
    file: Pick<SkillFile, 'path' | 'contentKind' | 'contentBase64'>; testID: string; onDownload?: () => void }>) {
    const isActive = useLayoutPresentationActive();
    const bytes = React.useMemo(() => decodeBase64(props.file.contentBase64), [props.file.contentBase64]);
    const viewer = React.useMemo(() => resolveFileViewerKind({ path: props.file.path,
        isBinaryContent: props.file.contentKind === 'binary', head: bytes }), [bytes, props.file.path, props.file.contentKind]);
    const source = React.useMemo(() => ({ enabled: isActive,
        source: { kind: 'bytes' as const, bytes, name: props.file.path }, mimeType: viewer.mimeType,
    }), [bytes, isActive, props.file.path, viewer.mimeType]);
    if (props.file.contentKind === 'utf8') return <>
        <CodeBlockView code={new TextDecoder().decode(bytes)} wrap showHeaderRow={false} />
        {props.onDownload ? <SectionActionButton title={t('botTemplateRecipient.download')} icon="download"
            testID={`${props.testID}:download`} onPress={props.onDownload} /> : null}
    </>;
    return <FileViewerBody viewer={viewer} title={props.file.path} source={source} sizeBytes={bytes.length}
        isActive={isActive} findSurfaceId={props.testID} layout="inline" onDownload={props.onDownload} testID={props.testID} />;
}

function PreviewFile(props: Readonly<{ file: SkillFile; skillKey: string; onDownloadFile?: BotTemplatePreviewProps['onDownloadFile'] }>) {
    const [expanded, setExpanded] = React.useState(props.file.path === 'SKILL.md');
    const testID = `bot-template:file:${props.skillKey}:${props.file.path}`;
    const downloadFile = props.onDownloadFile;
    const mode = props.file.unixMode;
    const subtitle = typeof mode === 'number' ? `0o${mode.toString(8)}${mode & 0o111 ? ` · ${t('botTemplateRecipient.executable')}` : ''}` : undefined;
    return <ExpandableItem expanded={expanded} onExpandedChange={setExpanded}
        testID={`${testID}:disclosure`} header={({ headerProps }) =>
            <Item {...headerProps} testID={testID} title={props.file.path} subtitle={subtitle} showChevron={false} />}>
        {expanded ? <SectionContentRow><BotTemplateFilePreview file={props.file} testID={testID}
            onDownload={downloadFile ? () => downloadFile(props.skillKey, props.file.path) : undefined} /></SectionContentRow> : null}
    </ExpandableItem>;
}

type Need = BotTemplateContentV1['needs'][keyof BotTemplateContentV1['needs']][number];
const NEED_KINDS = [
    { kind: 'software', icon: 'terminal', label: 'botTemplates.kindSoftware' },
    { kind: 'connectedAccounts', icon: 'user-circle', label: 'botTemplates.kindAccount' },
    { kind: 'mcpServers', icon: 'plug', label: 'botTemplates.kindMcp' },
] as const;

/** Required needs say what they are for; optional ones say what happens without them. */
function needLine(need: Need) {
    return need.requirement === 'required'
        ? `${t('botTemplateRecipient.required')} · ${need.purpose}`
        : `${t('botTemplateRecipient.optional')} · ${need.skipConsequence}`;
}

/**
 * Content only: every channel and the author editor share BT2's surrounding identity header. Ordered
 * as a person decides: its first task, what it needs, then everything it carries, complete, before
 * anything is created (MCP definitions stay visible, never folded).
 */
export function BotTemplatePreview({ content, onDownloadFile }: BotTemplatePreviewProps) {
    const hasNeeds = NEED_KINDS.some(({ kind }) => content.needs[kind].length > 0);
    return <>
        {content.firstTask ? <ItemGroup title={t('botTemplates.tryItWith')}>
            <Item testID="bot-template-first-task" title={content.firstTask} subtitle={t('botTemplates.firstTaskHint')}
                icon={<Icon name="sparkle" />} showChevron={false} />
        </ItemGroup> : null}
        {hasNeeds ? <ItemGroup title={t('botTemplates.whatItNeeds')} description={t('botTemplates.needsChecked')}>
            {NEED_KINDS.flatMap(({ kind, icon, label }) => content.needs[kind].map((need: Need) => <React.Fragment key={`${kind}:${need.key}`}>
                <Item testID={`bot-template-need:${kind}:${need.key}`} title={need.name} subtitle={needLine(need)}
                    icon={<Icon name={icon} />} detail={t(label)} showChevron={false} />
                {'definition' in need ? <SectionContentRow>
                    <CodeBlockView code={JSON.stringify(need.definition, null, 2)} language="json" wrap />
                </SectionContentRow> : null}
            </React.Fragment>))}
        </ItemGroup> : null}
        <ItemGroup title={t('botTemplates.instructions')}>
            <SectionContentRow><Text selectable style={styles.instructions}>{content.instructions.markdown}</Text></SectionContentRow>
        </ItemGroup>
        {content.memoryRules.length > 0 ? <ItemGroup title={t('botTemplateRecipient.memoryRules')}>
            {content.memoryRules.map(rule => <Item key={rule.key} title={rule.text} subtitle={rule.topic} showChevron={false} />)}
        </ItemGroup> : null}
        {content.skills.map(skill => <ItemGroup key={skill.key} title={skill.title}>
            {skill.entries.map(file => <PreviewFile key={file.path} skillKey={skill.key} file={file} onDownloadFile={onDownloadFile} />)}
        </ItemGroup>)}
    </>;
}

const styles = StyleSheet.create(theme => ({
    instructions: { color: theme.colors.text.primary },
}));
