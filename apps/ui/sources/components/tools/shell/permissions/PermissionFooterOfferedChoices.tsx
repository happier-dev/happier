import * as React from 'react';
import { type View, type StyleProp, type ViewStyle } from 'react-native';
import { OfferedChoices } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { isRefusingPermissionChoice } from '@/sync/ops/sessionPermissionChoices';
import { PermissionDecisionButton } from './PermissionDecisionButton';
import { renderPermissionFeedbackInput } from './PermissionFeedbackInput';
import { isOfferedPermissionChoiceAvailable, type OfferedPermissionChoice } from './offeredChoiceLayout';

type Props = Readonly<{
  choices: readonly OfferedPermissionChoice[];
  nativeSource?: string;
  primaryId: string | null;
  /** Every choice is withheld (answered, pending, unconfirmed). */
  disabled: boolean;
  busyChoiceId: string | null;
  permissionOwnerLabel?: string;
  /** `feedback` is present only for a choice that accepts it and only when the person wrote some. */
  onChoose: (choiceId: string, feedback?: string) => void;
  primaryRef?: React.Ref<View>;
}>;

/** The second line of a list row: the producer's own rule preview, else what the offered scope means. */
function describeOfferedChoice(choice: OfferedPermissionChoice, ownerRequiredReason: string, nativeSource?: string): string | null {
  if (!isOfferedPermissionChoiceAvailable(choice))
    return ownerRequiredReason;
  if (choice.rulePreview) return choice.rulePreview;
  if (isRefusingPermissionChoice(choice)) return null;
  if (choice.scope === 'session')
    return t('capabilities.session.toolAsk.untilSessionEnds');
  if (choice.scope === 'localPersistent')
    return nativeSource === 'muse' && !choice.followUp
      ? t('capabilities.session.toolAsk.savedInMuseSettings')
      : t('capabilities.session.toolAsk.savedForLater');
  return null;
}

/** Domain adapter: selection, availability and localized scope meaning stay with permissions. */
export const PermissionFooterOfferedChoices = React.memo(function PermissionFooterOfferedChoices(props: Props) {
  const { theme } = useUnistyles();
  const presentationTheme = usePluginUiTheme(theme);
  const ownerRequiredReason = t('capabilities.session.toolAsk.ownerRequired', { owner: props.permissionOwnerLabel });
  return <OfferedChoices theme={presentationTheme}
    choices={props.choices.map(choice => ({
      id: choice.id, label: choice.label, refusal: isRefusingPermissionChoice(choice),
      available: isOfferedPermissionChoiceAvailable(choice), allowsFeedback: choice.allowsFeedback,
      description: describeOfferedChoice(choice, ownerRequiredReason, props.nativeSource),
    }))}
    primaryId={props.primaryId} disabled={props.disabled} busyChoiceId={props.busyChoiceId}
    unavailableReason={ownerRequiredReason}
    unavailableIcon={<Icon name="info" size={14} color={theme.colors.text.secondary} />}
    feedbackPlaceholder={t('capabilities.session.toolAsk.feedbackPlaceholder')} cancelLabel={t('common.cancel')}
    onChoose={props.onChoose} testID="permission-footer" renderFeedbackInput={renderPermissionFeedbackInput}
    renderButton={({ primary, style, ...button }) => <PermissionDecisionButton {...button}
      ref={primary ? props.primaryRef : undefined} style={style as StyleProp<ViewStyle>}
      accessibilityRole="button" activeOpacity={0.7} />} />;
});
