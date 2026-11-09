import * as React from 'react';
import { Keyboard, Platform } from 'react-native';

import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { t } from '@/text';
import type { CodeIntelligenceController } from '@/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';
import type {
  CodeEditorCommand,
  CodeEditorHistory,
  TextEditorHandle,
} from '../codeEditorTypes';
import { EditorAccessoryBar, EditorAccessoryChip } from './EditorAccessoryBar';
import { EditorSignatureStrip } from './EditorSignatureStrip';

const noInlineSubscription = (_listener: () => void) => () => {};
const noInlineSuggestion = () => null;
const noSignatureSubscription = (_listener: () => void) => () => {};
const noSignatureHelp = () => null;
const noLanguageSubscription = (_listener: () => void) => () => {};
const noLanguageKeys = () => '';

/** Symbol keys a phone keyboard buries a layer or two deep, in the order code reaches for them. */
const SYMBOL_KEYS = [
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  '"',
  "'",
  '/',
  ',',
  ';',
  '=',
  '<',
  '>',
  '|',
  '&',
] as const;

/** The editor's Save: primary once dirty, quiet while the Machine can't take it, hidden during a conflict. */
export type EditorAccessorySave = Readonly<{
  visible: boolean;
  enabled: boolean;
  tone: 'primary' | 'default';
  busy?: boolean;
  onPress(): void;
}>;

export type CodeEditorAccessoryBarProps = Readonly<{
  editor: TextEditorHandle | null;
  save: EditorAccessorySave;
  /** Present when the file has change marks: steps to the next change and opens its peek. */
  onChanges?: () => void;
  /**
   * The File page's one language-intelligence controller. Suggest, Expand and Shrink are offered only
   * once the server can answer them (P7-R20, P7-R26); without it the row stays as it was.
   */
  languageIntelligence?: Pick<CodeIntelligenceController, 'getSnapshot' | 'subscribe'> & Partial<Pick<CodeIntelligenceController, 'nextEditSuggestions'>> | null;
  testID?: string;
}>;

function useEditorHistory(editor: TextEditorHandle | null): CodeEditorHistory {
  const [history, setHistory] = React.useState<CodeEditorHistory>({
    canUndo: false,
    canRedo: false,
  });
  React.useEffect(() => editor?.subscribeHistory?.(setHistory), [editor]);
  return history;
}

/** Which language keys the server can answer, as a stable primitive so the row re-renders only when it changes. */
function useLanguageKeys(language: CodeEditorAccessoryBarProps['languageIntelligence']) {
  const read = React.useCallback(() => {
    const capabilities = language?.getSnapshot().capabilities;
    return `${capabilities?.completion === true ? 'c' : ''}${capabilities?.selectionRange === true ? 's' : ''}`;
  }, [language]);
  const keys = React.useSyncExternalStore(language?.subscribe ?? noLanguageSubscription, language ? read : noLanguageKeys, noLanguageKeys);
  return { suggest: keys.includes('c'), selection: keys.includes('s') };
}

/** A predicted next edit (P7-R33) reuses the AI Accept/Dismiss keys: the first jumps to it, the second applies it. */
function useNextEditStep(language: CodeEditorAccessoryBarProps['languageIntelligence']): 'ready' | 'preview' | null {
  const operation = language?.nextEditSuggestions;
  const read = React.useCallback(() => {
    const snapshot = operation?.getSnapshot();
    return snapshot?.suggestion && (snapshot.status === 'ready' || snapshot.status === 'preview') ? snapshot.status : null;
  }, [operation]);
  return React.useSyncExternalStore(operation?.subscribe ?? noLanguageSubscription, read, () => null);
}

function hideKeyboard() {
  if (Platform.OS !== 'web') {
    Keyboard.dismiss();
    return;
  }
  if (
    typeof document !== 'undefined' &&
    document.activeElement instanceof HTMLElement
  )
    document.activeElement.blur();
}

/** The key row's first key, pinned before the scrolling keys: put the keyboard away. */
export function EditorAccessoryHideKeyboardKey(props: Readonly<{ testID: string }>) {
  return (
    <EditorAccessoryChip
      testID={`${props.testID}-hide-keyboard`}
      icon="keyboard"
      label={t('files.editing.hideKeyboard')}
      onPress={hideKeyboard}
    />
  );
}

/** The key row's pinned Save, the one Save of the phone editor (code and Markdown alike, ED1p/ED1mp). */
export function EditorAccessorySaveKey(props: Readonly<{ testID: string; save: EditorAccessorySave }>) {
  if (!props.save.visible) return null;
  return (
    <ToolbarButton
      testID={`${props.testID}-save`}
      label={t('common.save')}
      size="md"
      tone={props.save.tone}
      disabled={!props.save.enabled}
      busy={props.save.busy}
      onPress={props.save.onPress}
    />
  );
}

/**
 * The phone editor's one key row above the keyboard (files lab ED1p, ade-shell Ep, P4-R7): hide
 * keyboard, Tab and outdent, the code symbols, the caret arrows, Find and Changes, with Undo and Save
 * pinned at the end. Every key is an editor command through the handle, never a synthetic key event;
 * the engine refuses commands while an IME composition is open.
 */
export const CodeEditorAccessoryBar = React.memo(
  function CodeEditorAccessoryBar(props: CodeEditorAccessoryBarProps) {
    const { editor } = props;
    const inline = editor?.inlineSuggestions;
    const inlineSuggestion = React.useSyncExternalStore(inline?.subscribeContext ?? noInlineSubscription,
      inline?.getSuggestion ?? noInlineSuggestion, noInlineSuggestion);
    const signature = React.useSyncExternalStore(editor?.subscribeSignatureHelp ?? noSignatureSubscription,
      editor?.getSignatureHelp ?? noSignatureHelp, noSignatureHelp);
    const languageKeys = useLanguageKeys(props.languageIntelligence);
    const nextEdit = useNextEditStep(props.languageIntelligence);
    const history = useEditorHistory(editor);
    const run = React.useCallback(
      (command: CodeEditorCommand) => {
        editor?.runCommand?.(command);
      },
      [editor],
    );
    const testID = props.testID ?? 'code-editor-accessory';
    return (
      <EditorAccessoryBar
        testID={testID}
        accessibilityLabel={t('files.editing.editorKeys')}
        above={<EditorSignatureStrip help={signature} testID={`${testID}-signature`} />}
        leading={<EditorAccessoryHideKeyboardKey testID={testID} />}
        trailing={
          <>
            <EditorAccessoryChip
              testID={`${testID}-undo`}
              icon="arrow-arc-left"
              label={t('common.undo')}
              disabled={!history.canUndo}
              onPress={() => run('undo')}
            />
            <EditorAccessorySaveKey testID={testID} save={props.save} />
          </>
        }
      >
        {nextEdit ? <>
          <EditorAccessoryChip
            testID={`${testID}-next-edit`}
            text={t(nextEdit === 'ready' ? 'files.editing.aiSuggestions.nextEditGo' : 'files.editing.aiSuggestions.nextEditApplyEdit')}
            label={t(nextEdit === 'ready' ? 'files.editing.aiSuggestions.nextEditGo' : 'files.editing.aiSuggestions.nextEditApplyEdit')}
            onPress={() => run('inlineSuggestAccept')}
          />
          <EditorAccessoryChip
            testID={`${testID}-next-edit-dismiss`}
            text={t('files.editing.aiSuggestions.nextEditDismiss')}
            label={t('files.editing.aiSuggestions.nextEditDismiss')}
            onPress={() => run('inlineSuggestDismiss')}
          />
        </> : inlineSuggestion ? <>
          <EditorAccessoryChip
            testID={`${testID}-inline-accept`}
            text={t('files.editing.aiSuggestions.accept')}
            label={t('files.editing.aiSuggestions.accept')}
            onPress={() => run('inlineSuggestAccept')}
          />
          <EditorAccessoryChip
            testID={`${testID}-inline-word`}
            text={t('files.editing.aiSuggestions.acceptWord')}
            label={t('files.editing.aiSuggestions.acceptWord')}
            onPress={() => run('inlineSuggestAcceptWord')}
          />
          <EditorAccessoryChip
            testID={`${testID}-inline-dismiss`}
            text={t('files.editing.aiSuggestions.dismiss')}
            label={t('files.editing.aiSuggestions.dismiss')}
            onPress={() => run('inlineSuggestDismiss')}
          />
        </> : inline ? <EditorAccessoryChip
          testID={`${testID}-inline-trigger`}
          text={t('files.editing.aiSuggestions.trigger')}
          label={t('files.editing.aiSuggestions.trigger')}
          onPress={() => run('inlineSuggestTrigger')}
        /> : null}
        {languageKeys.suggest ? <EditorAccessoryChip
          testID={`${testID}-suggest`}
          icon="list-bullets"
          label={t('files.pane.menu.suggest')}
          onPress={() => run('suggest')}
        /> : null}
        <EditorAccessoryChip
          testID={`${testID}-tab`}
          text="Tab"
          label={t('files.editing.indent')}
          onPress={() => run('indent')}
        />
        <EditorAccessoryChip
          testID={`${testID}-outdent`}
          text="⇤"
          label={t('files.editing.outdent')}
          onPress={() => run('outdent')}
        />
        {SYMBOL_KEYS.map((key) => (
          <EditorAccessoryChip
            key={key}
            testID={`${testID}-insert-${key}`}
            text={key}
            label={t('files.editing.insertText', { text: key })}
            onPress={() => run({ insert: key })}
          />
        ))}
        <EditorAccessoryChip
          testID={`${testID}-left`}
          icon="arrow-left"
          label={t('files.editing.moveLeft')}
          onPress={() => run('moveLeft')}
          repeat
        />
        <EditorAccessoryChip
          testID={`${testID}-right`}
          icon="arrow-right"
          label={t('files.editing.moveRight')}
          onPress={() => run('moveRight')}
          repeat
        />
        <EditorAccessoryChip
          testID={`${testID}-redo`}
          icon="arrow-arc-right"
          label={t('files.editing.redo')}
          disabled={!history.canRedo}
          onPress={() => run('redo')}
        />
        <EditorAccessoryChip
          testID={`${testID}-find`}
          icon="magnifying-glass"
          label={t('find.open')}
          onPress={() => run('find')}
        />
        {languageKeys.selection ? <>
          <EditorAccessoryChip
            testID={`${testID}-expand-selection`}
            icon="arrows-out"
            label={t('files.pane.menu.expandSelection')}
            onPress={() => run('expandSelection')}
          />
          <EditorAccessoryChip
            testID={`${testID}-shrink-selection`}
            icon="arrows-in"
            label={t('files.pane.menu.shrinkSelection')}
            onPress={() => run('shrinkSelection')}
          />
        </> : null}
        {props.onChanges ? (
          <EditorAccessoryChip
            testID={`${testID}-changes`}
            text={t('files.editing.changes')}
            label={t('files.editing.nextChange')}
            onPress={props.onChanges}
          />
        ) : null}
      </EditorAccessoryBar>
    );
  },
);
