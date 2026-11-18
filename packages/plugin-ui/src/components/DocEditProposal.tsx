import type { ReactElement } from 'react';
import { View } from 'react-native';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { resolveHappierDiffViewerRequest } from '../presentation/content/DiffViewer.js';
import { useOptionalHappierUiPalette, useOptionalHappierUiTypography } from '../environment/context.js';
import { HAPPIER_RADIUS_V1 } from '../environment/radius.js';
import { HAPPIER_SPACE_STEPS } from '../environment/spacing.js';
import {
  HappierDocEditProposal,
  type HappierDocEditProposalAction,
  type HappierDocEditProposalButtonProps,
  type HappierDocEditProposalDiffProps,
  type HappierDocEditProposalFooter,
  type HappierDocEditProposalLine,
  type HappierDocEditProposalMark,
  type HappierDocEditProposalMarkProps,
  type HappierDocEditProposalState,
  type HappierDocEditProposalTextProps,
  type HappierDocEditProposalTone,
} from '../presentation/content/DocEditProposal.js';
import type { HappierIconName } from '../presentation/content/Icon.js';
import { HappierText } from '../presentation/text/Text.js';
import { resolveHappierTypeRoleStyle } from '../presentation/text/typeRole.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { Spinner } from './Spinner.js';

export type DocEditProposalAction = HappierDocEditProposalAction;
export type DocEditProposalLine = HappierDocEditProposalLine;
export type DocEditProposalFooter = HappierDocEditProposalFooter;
export type DocEditProposalState = HappierDocEditProposalState;

export type DocEditProposalProps = Readonly<{
  testID: string;
  before: string;
  after: string;
  /** The author's state and wording; Accept and Decline call the author's Doc Actions. */
  decision: DocEditProposalState;
}>;

const KEY = 'happier.plugin-ui.docEditProposal';

/**
 * The suggested-edit card core shows in a Doc's passage thread. The author reads the suggestion and
 * its currency, and its decision callbacks invoke the Doc Actions, where the person's approval
 * still decides.
 */
export function DocEditProposal(props: DocEditProposalProps): ReactElement {
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme);
  const translate = usePluginTranslation();
  return <HappierDocEditProposal {...props}
    labels={{ before: translate(`${KEY}.before`, 'Before'), after: translate(`${KEY}.after`, 'After') }}
    Text={ProposalText} Mark={ProposalMark} Button={ProposalButton} Diff={ProposalDiff} Spinner={ProposalSpinner}
    style={{
      padding: HAPPIER_SPACE_STEPS.s12, borderRadius: HAPPIER_RADIUS_V1.lg,
      backgroundColor: palette?.inset ?? theme.colors.elevatedSurface, borderWidth: 1, borderColor: theme.colors.divider,
    }} />;
}

function toneColor(tone: HappierDocEditProposalTone | undefined, theme: ReturnType<typeof usePluginTheme>): string {
  return tone === 'warning' ? theme.statusText?.warning ?? theme.colors.warning
    : tone === 'danger' ? theme.statusText?.danger ?? theme.colors.danger
    : tone === 'muted' ? theme.colors.mutedText : theme.colors.secondaryText;
}

const ROLE = { title: 'label', meta: 'meta', reason: 'body', line: 'meta', receipt: 'meta' } as const;

function ProposalText(props: HappierDocEditProposalTextProps): ReactElement {
  const theme = usePluginTheme();
  const typography = useOptionalHappierUiTypography();
  const color = props.role === 'title' || props.role === 'receipt' ? theme.colors.text
    : props.role === 'meta' ? theme.colors.mutedText : toneColor(props.tone, theme);
  return <HappierText testID={props.testID} numberOfLines={props.numberOfLines} tabularNumbers={props.role === 'meta'} style={[
    resolveHappierTypeRoleStyle(ROLE[props.role], theme, typography,
      props.role === 'title' ? 'semiBold' : props.role === 'receipt' ? 'medium' : undefined),
    { color },
  ]}>{props.children}</HappierText>;
}

const MARK: Readonly<Record<HappierDocEditProposalMark, HappierIconName>> = {
  proposal: 'review', reason: 'forward', current: 'check', accepted: 'check', declined: 'close',
  undone: 'refresh', warning: 'warning', failed: 'error', locked: 'denied',
};

function ProposalMark(props: HappierDocEditProposalMarkProps): ReactElement {
  return <Icon name={MARK[props.mark]} size="small"
    tone={props.tone === 'warning' ? 'warning' : props.tone === 'danger' ? 'danger' : props.tone === 'muted' ? 'muted' : 'secondary'} />;
}

function ProposalButton(props: HappierDocEditProposalButtonProps): ReactElement {
  return <Button title={props.label} size="small" testID={props.testID}
    variant={props.emphasis === 'primary' ? 'primary' : props.emphasis === 'plain' ? 'plain' : 'secondary'}
    disabled={props.disabled} busy={props.busy} onPress={props.onPress} />;
}

function ProposalSpinner(): ReactElement {
  return <Spinner size="small" />;
}

/**
 * The before/after through the host's one diff renderer, so a plugin's suggestion reads exactly like
 * core's. Without a bound host, the author's passage is shown plainly: the replaced text struck, the new one beneath.
 */
function ProposalDiff(props: HappierDocEditProposalDiffProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const theme = usePluginTheme();
  const typography = useOptionalHappierUiTypography();
  const hosted = host?.renderDiffViewer?.(resolveHappierDiffViewerRequest({
    before: props.before, after: props.after, beforeLabel: props.beforeLabel, afterLabel: props.afterLabel,
    ...(props.testID === undefined ? {} : { testID: props.testID }),
  }));
  if (hosted !== undefined && hosted !== null) return <>{hosted}</>;
  const label = [resolveHappierTypeRoleStyle('micro', theme, typography), { color: theme.colors.mutedText }];
  const body = resolveHappierTypeRoleStyle('body', theme, typography);
  return <View testID={props.testID} style={{ gap: HAPPIER_SPACE_STEPS.s4 }}>
    <HappierText style={label}>{props.beforeLabel}</HappierText>
    <HappierText selectable style={[body, { color: theme.colors.secondaryText, textDecorationLine: 'line-through' }]}>{props.before}</HappierText>
    <HappierText style={label}>{props.afterLabel}</HappierText>
    <HappierText selectable style={[body, { color: theme.colors.text }]}>{props.after}</HappierText>
  </View>;
}
