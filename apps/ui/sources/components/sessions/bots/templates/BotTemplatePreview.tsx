import * as React from 'react';
import type { BotTemplateContentV1, BotTemplateSkillV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { readSkillFrontmatterV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { extractFrontMatter } from '@/components/ui/markdown/editor/core/eligibility/markdownFrontmatter';
import { readSkillText } from '@/components/settings/skills/detail/skillFileContent';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Icon } from '@/components/ui/icons/Icon';
import { FileViewerBody } from '@/components/workspaces/files/file/FileViewerBody';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { t } from '@/text';

export type BotTemplatePreviewProps = Readonly<{
    content: BotTemplateContentV1;
    onDownloadFile?: (skillKey: string, path: string) => void;
    showNeeds?: boolean;
}>;

type SkillFile = BotTemplateSkillV1['entries'][number];

/** Instructions and carried files share one closed-by-default inspection control. */
function BotTemplateDisclosure(props: Readonly<{
    children: React.ReactNode; title: string; description?: string; testID: string; icon?: React.ReactNode;
}>) {
    const [expanded, setExpanded] = React.useState(false);
    return <ExpandableItem expanded={expanded} onExpandedChange={setExpanded} testID={`${props.testID}:disclosure`}
        header={({ headerProps }) => <Item {...headerProps} testID={props.testID}
            title={props.title} subtitle={props.description} icon={props.icon} showChevron={false} />}>
        {expanded ? props.children : null}
    </ExpandableItem>;
}

export function BotTemplateInstructions(props: Readonly<{ children: React.ReactNode; description?: string }>) {
    return <ItemGroup><BotTemplateDisclosure testID="bot-template-instructions-disclosure"
        title={t('botTemplates.instructions')} description={props.description} icon={<Icon name="book-open" />}>
        {props.children}
    </BotTemplateDisclosure></ItemGroup>;
}

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
    const testID = `bot-template:file:${props.skillKey}:${props.file.path}`;
    const downloadFile = props.onDownloadFile;
    const mode = props.file.unixMode;
    const subtitle = typeof mode === 'number' ? `0o${mode.toString(8)}${mode & 0o111 ? ` · ${t('botTemplateRecipient.executable')}` : ''}` : undefined;
    return <BotTemplateDisclosure testID={testID} title={props.file.path} description={subtitle}>
        <SectionContentRow><BotTemplateFilePreview file={props.file} testID={testID}
            onDownload={downloadFile ? () => downloadFile(props.skillKey, props.file.path) : undefined} /></SectionContentRow>
    </BotTemplateDisclosure>;
}

type Need = BotTemplateContentV1['needs'][keyof BotTemplateContentV1['needs']][number];
const NEED_KINDS = [
    { kind: 'software', icon: 'terminal', label: 'botTemplates.kindSoftware' },
    { kind: 'connectedAccounts', icon: 'user-circle', label: 'botTemplates.kindAccount' },
    { kind: 'mcpServers', icon: 'plug', label: 'botTemplates.kindMcp' },
] as const;

/** Required needs say what they are for; optional ones say what happens without them (preview and setup alike). */
export function botTemplateNeedLine(need: Need) {
    return need.requirement === 'required'
        ? `${t('botTemplateRecipient.required')} · ${need.purpose}`
        : `${t('botTemplateRecipient.optional')} · ${need.skipConsequence}`;
}

/**
 * Content only: every channel and the author editor share BT2's surrounding identity header. Ordered
 * as a person decides: its first task, what it needs, then everything it carries, complete, before
 * anything is created (MCP definitions stay visible, never folded).
 */
export function BotTemplatePreview({ content, onDownloadFile, showNeeds = true }: BotTemplatePreviewProps) {
    const needs = NEED_KINDS.flatMap(({ kind, icon, label }) => content.needs[kind].map((need: Need) => ({ kind, icon, label, need })));
    return <>
        {/* Both sections keep their place when empty, so every template reads the same way (lab r2 install-preview). */}
        <ItemGroup title={t('botTemplates.tryItWith')}>
            {content.firstTask ? <Item testID="bot-template-first-task" title={content.firstTask} subtitle={t('botTemplates.firstTaskHint')}
                icon={<Icon name="sparkle" />} showChevron={false} />
                : <Item testID="bot-template-first-task-empty" title={t('botTemplates.noFirstTask')}
                    subtitle={t('botTemplates.noFirstTaskHint')} icon={<Icon name="sparkle" />} showChevron={false} mode="info" />}
        </ItemGroup>
        {showNeeds ? <ItemGroup title={t('botTemplates.whatItNeeds')} description={needs.length > 0 ? t('botTemplates.needsChecked') : undefined}>
            {needs.length > 0 ? needs.map(({ kind, icon, label, need }) => <React.Fragment key={`${kind}:${need.key}`}>
                <Item testID={`bot-template-need:${kind}:${need.key}`} title={need.name} subtitle={botTemplateNeedLine(need)}
                    icon={<Icon name={icon} />} detail={t(label)} showChevron={false} />
                {'definition' in need ? <SectionContentRow>
                    <CodeBlockView code={JSON.stringify(need.definition, null, 2)} language="json" wrap />
                </SectionContentRow> : null}
            </React.Fragment>) : <Item testID="bot-template-needs-empty" title={t('botTemplates.needsNothing')}
                subtitle={t('botTemplates.needsNothingHint')} icon={<Icon name="check-circle" />} showChevron={false} mode="info" />}
        </ItemGroup> : null}
        <BotTemplateInstructions>
            <SectionContentRow><MarkdownView testID="bot-template-instructions-document" markdown={content.instructions.markdown} selectable /></SectionContentRow>
        </BotTemplateInstructions>
        {content.memoryRules.length > 0 ? <ItemGroup title={t('botTemplateRecipient.memoryRules')}>
            {content.memoryRules.map(rule => <Item key={rule.key} title={rule.text} subtitle={rule.topic} showChevron={false} />)}
        </ItemGroup> : null}
        {content.skills.length > 0 ? <ItemGroup title={t('botTemplateRecipient.skills')}>
            {content.skills.map(skill => <PreviewSkill key={skill.key} skill={skill} onDownloadFile={onDownloadFile} />)}
        </ItemGroup> : null}
    </>;
}

/** The skill's own instructions: SKILL.md read as the skill (its front matter says what it is for), never as a file. */
function readSkillDocument(skill: BotTemplateSkillV1) {
    const entry = skill.entries.find(file => file.path === 'SKILL.md' && file.contentKind === 'utf8');
    if (!entry) return null;
    const markdown = readSkillText(entry.contentBase64);
    return { description: readSkillFrontmatterV1(markdown).description ?? undefined, body: extractFrontMatter(markdown).body.trimStart() };
}

/** One row per skill: its name and purpose; opened, its instructions as a document, then any files it carries. */
function PreviewSkill(props: Readonly<{ skill: BotTemplateSkillV1; onDownloadFile?: BotTemplatePreviewProps['onDownloadFile'] }>) {
    const document = React.useMemo(() => readSkillDocument(props.skill), [props.skill]);
    const files = props.skill.entries.filter(file => !(document && file.path === 'SKILL.md'));
    return <BotTemplateDisclosure testID={`bot-template-skill:${props.skill.key}`} title={props.skill.title}
        description={document?.description} icon={<Icon name="lightbulb" />}>
        {document?.body ? <SectionContentRow><MarkdownView markdown={document.body} selectable /></SectionContentRow> : null}
        {files.map(file => <PreviewFile key={file.path} skillKey={props.skill.key} file={file} onDownloadFile={props.onDownloadFile} />)}
    </BotTemplateDisclosure>;
}
