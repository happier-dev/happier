import { useCallback, type ReactElement, type ReactNode } from 'react';
import type { JsonValue, PluginReference } from '@happier-dev/plugin-sdk';
import type {
  PluginUiActionInputFor,
  PluginUiActionReference,
  PluginUiActionResultFor,
} from '@happier-dev/plugin-sdk/ui';

import { usePluginHostApi } from '../hostApi/context.js';
import {
  useExecutePluginAction,
  type PluginActionExecution,
} from '../hostApi/executeAction.js';
import {
  HappierActionPanel,
  HappierActionPanelSection,
} from '../presentation/interaction/ActionPanel.js';
import { Button, type ButtonVariant } from './Button.js';
import { usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';

/**
 * The action family (§3.9) — how anything a plugin surface offers actually
 * happens.
 *
 * Its predecessor was a single inert `happier-plugin-action` element carrying a
 * `PluginUiPortableAction` object that nothing ever executed: an author could
 * declare an action and the user could not press it. That marker AND its
 * parallel action vocabulary are deleted in the same change that lands this
 * file (§3.10.3 step 5); the canonical vocabulary is the host's own
 * `PluginReference` + `PluginUiHostApi` method, never a second bag of
 * `{ kind: 'copy' | 'openExternal' | … }` discriminants this package would have
 * to keep in sync.
 *
 * These are **plugin adapters**, so §8.2's both-consumers rule explicitly does
 * not apply and they must not acquire a fake Happier core counterpart. What they
 * must not become is a second action OWNER: each one routes to the canonical
 * host method for its concern — `executeAction`, `writeClipboard`,
 * `openExternalLink`, `openSurface` — passing the author's own reference and
 * input unparsed and unreinterpreted (§3.5). Deciding what an action id means,
 * evaluating policy and stamping the execution surface belong to the host
 * dispatcher.
 *
 * Chrome and the press→pending machine are not re-implemented either: every
 * member renders {@link Button}, which renders the shared `HappierPressable`
 * that Happier core's own buttons render (UI-T27).
 */

/**
 * What every action member accepts, beyond its own concern.
 *
 * There is no `onPress`: an `Action` whose behaviour the author supplies is a
 * {@link Button}, and offering both would make "which one runs the action" a
 * question. The members below differ ONLY in which host owner they reach.
 */
type ActionChromeProps = Readonly<{
  /** Literal label. Each member carries a sensible default. */
  title?: string;
  /** A key from this plugin's declared translation bundle; `title` is its fallback. */
  titleKey?: string;
  /** Leading glyph. Sized and tinted by the caller. */
  icon?: ReactNode;
  variant?: ButtonVariant;
  disabled?: boolean;
  /** Overrides the accessible name when the visible label is an abbreviation. */
  accessibilityLabel?: string;
  testID?: string;
}>;

type ActionButtonProps = ActionChromeProps & Readonly<{
  /** The label used when the author supplies neither `title` nor a declared key. */
  defaultTitle: string;
  /** A host-reserved translation key for this framework-owned action chrome. */
  defaultTitleKey: string;
  /**
   * Declared pending state, for a member whose work is tracked by a hook rather
   * than by the press promise. Omitted members let the press promise drive it.
   */
  busy?: boolean;
  onPress: () => unknown;
}>;

function ActionButton({
  defaultTitle,
  defaultTitleKey,
  title,
  titleKey,
  icon,
  variant = 'secondary',
  disabled,
  busy,
  accessibilityLabel,
  testID,
  onPress,
}: ActionButtonProps): ReactElement {
  const translate = usePluginTranslation();
  const resolvedDefaultTitle = translate(defaultTitleKey, defaultTitle);
  // `title ?? resolvedDefaultTitle` rather than a second author-resolution
  // pass: `Button` owns the one `value`/`valueKey` degradation rule, so an
  // undeclared key falls back to host-localized framework chrome and never
  // leaks the raw key.
  return (
    <Button
      title={title ?? resolvedDefaultTitle}
      titleKey={titleKey}
      icon={icon}
      variant={variant}
      disabled={disabled}
      busy={busy}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      onPress={onPress}
    />
  );
}

export type ActionExecuteProps<TAction extends PluginUiActionReference = PluginUiActionReference> = ActionChromeProps & Readonly<{
  /** A local action id or a `{ pluginId, localId }` reference to any plugin. */
  action: TAction;
  input?: NoInfer<PluginUiActionInputFor<NoInfer<TAction>>>;
  /**
   * The settled outcome, delivered once per dispatch.
   *
   * A press that was ignored because one was already in flight settles nothing
   * and reports nothing — an author counting outcomes must not see a second one
   * for a dispatch that never happened.
   */
  onSettled?: (execution: PluginActionExecution<PluginUiActionResultFor<NoInfer<TAction>>>) => void;
}>;

/**
 * Run a contributed or host action.
 *
 * The pending state comes from {@link useExecutePluginAction} rather than from
 * the press promise, so the button and the author's `onSettled` read the SAME
 * execution — a control that looked idle while the hook still considered the
 * action in flight is exactly the disagreement that produces a duplicate
 * mutation.
 */
function ActionExecute<TAction extends PluginUiActionReference>({
  action,
  input,
  onSettled,
  ...chrome
}: ActionExecuteProps<TAction>): ReactElement {
  const { execution, execute } = useExecutePluginAction(action, input);

  const onPress = useCallback(async () => {
    const settled = await execute();
    if (settled.status !== 'pending') onSettled?.(settled);
  }, [execute, onSettled]);

  return (
    <ActionButton
      defaultTitle="Run"
      defaultTitleKey="happier.plugin-ui.action.execute"
      busy={execution.status === 'pending'}
      onPress={onPress}
      {...chrome}
    />
  );
}

export type ActionCopyProps = ActionChromeProps & Readonly<{ value: string }>;

/** Put text on the user's clipboard through the host's clipboard owner. */
function ActionCopy({ value, ...chrome }: ActionCopyProps): ReactElement {
  const hostApi = usePluginHostApi();
  const onPress = useCallback(() => hostApi.writeClipboard(value), [hostApi, value]);

  return <ActionButton defaultTitle="Copy" defaultTitleKey="happier.plugin-ui.action.copy" onPress={onPress} {...chrome} />;
}

export type ActionOpenExternalProps = ActionChromeProps & Readonly<{ url: string }>;

/**
 * Hand a URL to the host to open outside the surface.
 *
 * The role stays `button`, not `link`: nothing navigates in place, and a screen
 * reader announcing "link" would promise in-surface navigation the host does not
 * perform.
 */
function ActionOpenExternal({ url, ...chrome }: ActionOpenExternalProps): ReactElement {
  const hostApi = usePluginHostApi();
  const onPress = useCallback(() => hostApi.openExternalLink(url), [hostApi, url]);

  return <ActionButton defaultTitle="Open" defaultTitleKey="happier.plugin-ui.action.open" onPress={onPress} {...chrome} />;
}

export type ActionOpenSurfaceProps = ActionChromeProps & Readonly<{
  /** A local view id or a `{ pluginId, localId }` reference to any plugin. */
  view: PluginReference;
  /** Launch input for the opened surface (§3.7). */
  input?: JsonValue;
}>;

/** Ask the host to open another plugin surface, with optional launch input. */
function ActionOpenSurface({ view, input, ...chrome }: ActionOpenSurfaceProps): ReactElement {
  const hostApi = usePluginHostApi();
  const onPress = useCallback(() => hostApi.openSurface(view, input), [hostApi, input, view]);

  return <ActionButton defaultTitle="Open" defaultTitleKey="happier.plugin-ui.action.open" onPress={onPress} {...chrome} />;
}

export type ActionRefreshProps = ActionChromeProps & Readonly<{
  /**
   * Re-read whatever this surface shows — normally the `refresh` returned by
   * `usePluginResource`.
   *
   * Deliberately caller-supplied: this component does not know which resources a
   * surface reads, and a version that guessed would be a second resource owner.
   * Return a thenable to get the pending state for free.
   */
  onRefresh: () => unknown;
}>;

/** Re-read the surface's data, presented consistently across every plugin. */
function ActionRefresh({ onRefresh, ...chrome }: ActionRefreshProps): ReactElement {
  return <ActionButton defaultTitle="Refresh" defaultTitleKey="happier.plugin-ui.action.refresh" onPress={onRefresh} {...chrome} />;
}

/**
 * The action family (§3.10.5: a cohesive compound family, not a prop bag).
 *
 * There is no bare `<Action>`: an action without a destination is not a thing a
 * surface can offer, and the predecessor's single component with a `kind`
 * discriminant is exactly the shape that made every action look pressable and be
 * inert.
 */
export const Action = Object.freeze({
  Execute: ActionExecute,
  Copy: ActionCopy,
  OpenExternal: ActionOpenExternal,
  OpenSurface: ActionOpenSurface,
  Refresh: ActionRefresh,
});

type ActionGroupProps = Readonly<{
  /** The group's accessible name. */
  title?: string;
  /** A key from this plugin's declared translation bundle; `title` is its fallback. */
  titleKey?: string;
  testID?: string;
  children?: ReactNode;
}>;

function ActionPanelRoot({ title, titleKey, testID, children }: ActionGroupProps): ReactElement {
  const translate = usePluginTranslation();
  const label = resolveAuthorText(translate, title, titleKey);

  return (
    <HappierActionPanel title={label} testID={testID}>
      {children}
    </HappierActionPanel>
  );
}

/**
 * A named subset of one panel's actions.
 *
 * It is a `group`, never a nested `toolbar`: a screen reader entering a toolbar
 * inside a toolbar announces two action contexts for one row, and the user then
 * has no way to tell which one the next control belongs to.
 */
function ActionPanelSection({ title, titleKey, testID, children }: ActionGroupProps): ReactElement {
  const translate = usePluginTranslation();
  const label = resolveAuthorText(translate, title, titleKey);

  return (
    <HappierActionPanelSection title={label} testID={testID}>
      {children}
    </HappierActionPanelSection>
  );
}

/**
 * The container an author groups a surface's actions in (§3.11's
 * "ActionPanel-like semantic container", made real).
 *
 * It supplies the semantics — one toolbar, named groups, host spacing — and
 * nothing about what the actions do.
 */
export const ActionPanel = Object.assign(ActionPanelRoot, { Section: ActionPanelSection });

export type ActionPanelProps = ActionGroupProps;
export type ActionPanelSectionProps = ActionGroupProps;
