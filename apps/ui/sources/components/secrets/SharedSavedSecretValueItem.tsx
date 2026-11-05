import * as React from 'react';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import type { SharedSavedSecretRevealInputV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';

import { useSharedSavedSecretReveal } from '@/components/secrets/useSharedSavedSecretReveal';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  SecretValueControls,
  SecretValueText,
} from '@/components/ui/copy/SecretValueDisclosure';
import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

/** A fixed shape: the mask never hints at the value's length. */
const MASKED_VALUE = '••••••••••••';

/**
 * A shared Saved Secret's value as one row, and the one person-only Reveal/Copy leaf every surface
 * that shows a managed Saved Secret reuses. Masked by default; a person who manages the secret can
 * reveal it after confirming, then copy it with an explicit gesture that is recorded on the same
 * history entry. Hiding, collapsing, leaving or any change to the secret forgets the value (the
 * data owner, {@link useSharedSavedSecretReveal}, clears it on every lifecycle edge). Where the
 * person cannot manage it, or this device cannot read it, the row says so and offers no Reveal.
 * An Agent or MCP reveal the person allowed arrives as `approvedReveal`: the row opens it once on
 * mount without a second confirmation, then behaves like any revealed row.
 */
export const SharedSavedSecretValueItem = React.memo(
  function SharedSavedSecretValueItem(
    props: Readonly<{
      testID: string;
      scope: ServerAccountScope;
      entry: SavedSecretCatalogEntryV1;
      /** The row is on screen; leaving it (collapsing the parent) forgets a revealed value. */
      active: boolean;
      onReplace?: () => void;
      replaceTestID?: string;
      disabled?: boolean;
      showDivider?: boolean;
      /** The admitted input of an allowed reveal request, and where its display outcome goes. */
      approvedReveal?: Readonly<{
        input: SharedSavedSecretRevealInputV1;
        onSettled: (result: unknown) => void;
      }>;
    }>,
  ) {
    const { entry } = props;
    const name = entry.name ?? t('secrets.catalog.unavailableName');
    const confirmDisclosure = React.useCallback(
      (selected: SavedSecretCatalogEntryV1) =>
        Modal.confirm(
          t('secretsSettings.revealConfirmTitle', {
            name: selected.name ?? t('secrets.catalog.unavailableName'),
          }),
          t('secretsSettings.revealConfirmBody'),
          {
            cancelText: t('common.cancel'),
            confirmText: t('secretsSettings.revealConfirm'),
          },
        ),
      [],
    );
    const disclosure = useSharedSavedSecretReveal({
      scope: props.scope,
      entry,
      confirmDisclosure,
    });
    const { hide, revealApproved } = disclosure;
    const approvedReveal = React.useRef(props.approvedReveal);
    React.useEffect(() => {
      const approved = approvedReveal.current;
      if (!approved) return;
      // Once per mount: the approval replay is waiting on this one display.
      approvedReveal.current = undefined;
      void revealApproved(approved.input).then(approved.onSettled, () =>
        approved.onSettled({ ok: false, errorCode: 'unavailable', error: 'unavailable' }),
      );
    }, [revealApproved]);
    const copyFeedback = useHappierCopyFeedback();
    React.useEffect(() => {
      if (!props.active) hide();
    }, [hide, props.active]);

    const canReveal =
      entry.source === 'shared_resource' &&
      entry.capabilities.manageAccess &&
      entry.revision !== null;
    const readable = entry.materialStatus === 'ready';
    const state = disclosure.state;
    const revealed = state.status === 'revealed' ? state.value : null;

    const copy = React.useCallback(() => {
      void disclosure.copy().then((outcome) => {
        if (outcome === 'succeeded') copyFeedback.markCopied();
        else if (outcome === 'outcome_unknown')
          Modal.alert(t('common.error'), t('secretsSettings.copyUnrecorded'));
        else Modal.alert(t('common.error'), t('secretsSettings.copyRefused'));
      });
    }, [copyFeedback, disclosure]);

    const replace = props.onReplace ? (
      <RoundButton
        testID={props.replaceTestID}
        size="small"
        display="secondary"
        title={t('secrets.actions.replace')}
        disabled={props.disabled}
        onPress={props.onReplace}
      />
    ) : null;

    const subtitle: Readonly<{ node: React.ReactNode; testID?: string }> = !canReveal
      ? { node: t('secretsSettings.valueSaved') }
      : !readable
        ? { node: t('secretsSettings.valueUnavailable'), testID: `${props.testID}-unavailable` }
        : state.status === 'refused'
          ? { node: t('secretsSettings.valueRefused'), testID: `${props.testID}-refused` }
          : {
              node: (
                <SecretValueText
                  testID={`${props.testID}-text`}
                  revealed={revealed}
                  mask={MASKED_VALUE}
                  maskedAccessibilityLabel={t('secretsSettings.valueSaved')}
                />
              ),
            };

    return (
      <Item
        testID={props.testID}
        title={t('secretsSettings.valueTitle')}
        subtitle={subtitle.node}
        subtitleTestID={subtitle.testID}
        subtitleLines={0}
        accessibilityLiveRegion={
          state.status === 'refused' ? 'polite' : undefined
        }
        mode="info"
        showChevron={false}
        showDivider={props.showDivider ?? false}
        accessoryLayout="adaptive"
        rightElementOutsidePressable
        rightElement={
          canReveal && readable ? (
            <SecretValueControls
              testIDPrefix={props.testID}
              revealed={revealed !== null}
              revealLabel={t('secretsSettings.revealValue')}
              hideLabel={t('secretsSettings.hideValue')}
              onToggleReveal={
                revealed !== null
                  ? hide
                  : () => {
                      void disclosure.reveal();
                    }
              }
              onCopy={revealed !== null ? copy : undefined}
              copied={copyFeedback.isCopied()}
              copyAccessibilityLabel={`${t('common.copy')}: ${name}`}
            >
              {replace}
            </SecretValueControls>
          ) : (
            (replace ?? undefined)
          )
        }
      />
    );
  },
);
