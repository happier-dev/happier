import * as React from 'react';
import { botTemplateEditorStyles as styles } from './botTemplateEditorStyles';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Switch } from '@/components/ui/forms/Switch';
import { InlineTextField } from '@/components/ui/text/InlineTextField';
import { Text } from '@/components/ui/text/Text';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { t } from '@/text';
import { useBotTemplateEditorValue } from './useBotTemplateEditor';
import type { BotTemplateEditorBuffer, BotTemplateSave } from './botTemplateEditorBuffer';

type Props = Readonly<{ buffer: BotTemplateEditorBuffer; save: BotTemplateSave }>;

export function BotTemplateMemorySection({ buffer, save }: Props) {
    const candidates = useBotTemplateEditorValue(buffer, state => state.draft.candidates.memoryRules);
    const copied = useBotTemplateEditorValue(buffer, state => state.draft.content.memoryRules);
    const [personalExpanded, setPersonalExpanded] = React.useState(false);
    const personal = candidates.filter(candidate => candidate.personal);
    const renderCandidate = (candidate: (typeof candidates)[number]) => <Item key={candidate.key} title={candidate.text}
        subtitle={candidate.personal ? t('botTemplates.personalFact') : candidate.topic} showChevron={false}
        rightElement={<Switch testID={`bot-template-memory:${candidate.key}`} value={candidate.selected}
            onValueChange={selected => { buffer.selectMemory(candidate.key, selected); void buffer.commit(save); }} />} />;
    return <ItemGroup title={t('botTemplates.fromMemory')} description={t('botTemplates.memoryDescription')}>
        {candidates.filter(candidate => !candidate.personal).map(renderCandidate)}
        {copied.filter(rule => !candidates.some(candidate => candidate.key === rule.key)).map(rule =>
            <Item key={rule.key} title={rule.text} subtitle={rule.topic} showChevron={false}
                rightElement={<Switch testID={`bot-template-memory:${rule.key}`} value onValueChange={() => {
                    buffer.edit(draft => ({ ...draft, candidates: { ...draft.candidates,
                        memoryRules: [...draft.candidates.memoryRules, { ...rule, selected: false, personal: false }] } }));
                    void buffer.commit(save);
                }} />} />)}
        {personal.length ? <ExpandableItem expanded={personalExpanded} onExpandedChange={setPersonalExpanded}
            header={({ headerProps }) => <Item {...headerProps} testID="bot-template-personal-facts"
                title={t('botTemplates.personalFacts', { count: personal.length })}
                detail={personal.some(candidate => candidate.selected) ? undefined : t('botTemplates.leftOut')} />}>
            {personalExpanded ? personal.map(renderCandidate) : null}
        </ExpandableItem> : null}
        {!candidates.length && !copied.length ? <SectionContentRow><Text variant="meta">{t('botTemplates.noMemory')}</Text></SectionContentRow> : null}
    </ItemGroup>;
}

export function BotTemplateSkillsSection(props: Props) {
    const keyList = useBotTemplateEditorValue(props.buffer, state => JSON.stringify([
        ...state.draft.content.skills.filter(skill => !state.draft.candidates.skills.some(candidate => candidate.key === skill.key)),
        ...state.draft.candidates.skills,
    ].map(skill => skill.key)));
    const keys = React.useMemo(() => JSON.parse(keyList) as string[], [keyList]);
    return <ItemGroup title={t('botTemplateRecipient.skills')} description={t('botTemplates.skillsDescription')}>
        {keys.map(key => <SkillCandidate key={key} {...props} skillKey={key} />)}
        {!keys.length ? <SectionContentRow><Text variant="meta">{t('botTemplates.noSkills')}</Text></SectionContentRow> : null}
    </ItemGroup>;
}

function SkillCandidate({ buffer, save, skillKey }: Props & Readonly<{ skillKey: string }>) {
    const candidate = useBotTemplateEditorValue(buffer, state => state.draft.candidates.skills.find(skill => skill.key === skillKey));
    const original = useBotTemplateEditorValue(buffer, state => state.draft.content.skills.find(skill => skill.key === skillKey));
    const skill = candidate ?? original;
    const [expanded, setExpanded] = React.useState(false);
    if (!skill) return null;
    const selection = candidate?.selection ?? 'as_is';
    const selected = selection === 'general_copy' && candidate?.generalCopy ? candidate.generalCopy : skill;
    const choose = (next: 'private' | 'as_is' | 'general_copy') => {
        if (!candidate) buffer.edit(draft => ({ ...draft, candidates: { ...draft.candidates,
            skills: [...draft.candidates.skills, { ...skill, selection: 'as_is' }] } }));
        buffer.selectSkill(skillKey, next);
        if (next === 'general_copy') setExpanded(true);
        void buffer.commit(save);
    };
    return <>
        <SegmentedChoiceItem title={skill.title} value={selection} onChange={choose} testIDPrefix={`bot-template-skill:${skillKey}`}
            options={[{ id: 'private', label: t('botTemplates.keepPrivate') }, { id: 'as_is', label: t('botTemplates.asIs') },
                { id: 'general_copy', label: t('botTemplates.generalCopy') }]} />
        {selection !== 'private' ? <ExpandableItem expanded={expanded} onExpandedChange={setExpanded}
            header={({ headerProps }) => <Item {...headerProps} title={t('botTemplates.reviewFiles')} testID={`bot-template-skill-files:${skillKey}`} />}>
            {expanded ? <>
                {selection === 'general_copy' ? <Item title={t('common.name')} rightElement={<InlineTextField style={styles.field} editor={{
                    value: selected.title, accessibilityLabel: t('common.name'), placeholder: t('common.name'),
                    onChangeText: title => buffer.edit(draft => ({ ...draft, candidates: { ...draft.candidates,
                        skills: draft.candidates.skills.map(item => item.key === skillKey && item.generalCopy
                            ? { ...item, generalCopy: { ...item.generalCopy, title } } : item) } })),
                    onCommit: () => { void buffer.commit(save); },
                }} />} /> : null}
                {selected.entries.map(file => <SectionContentRow key={file.path}>
                    <Text variant="meta">{file.path}</Text>
                    {file.contentKind === 'utf8' ? selection === 'general_copy'
                        ? <InlineTextField style={styles.field} multiline editor={{ value: new TextDecoder().decode(decodeBase64(file.contentBase64)),
                            accessibilityLabel: file.path, placeholder: file.path, testID: `bot-template-skill-file:${skillKey}:${file.path}`,
                            onChangeText: text => buffer.editSkillFile(skillKey, file.path, text), onCommit: () => { void buffer.commit(save); } }} />
                        : <CodeBlockView code={new TextDecoder().decode(decodeBase64(file.contentBase64))} wrap showHeaderRow={false} />
                        : <Text variant="meta">{t('botTemplates.binaryKept')}</Text>}
                </SectionContentRow>)}
            </> : null}
        </ExpandableItem> : null}
    </>;
}
