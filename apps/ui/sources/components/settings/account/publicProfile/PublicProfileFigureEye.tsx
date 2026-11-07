import * as React from 'react';
import type { HappierPublicProfileOwner, PublicUsageMetricId } from '@happier-dev/plugin-ui/presentation';
import type {
  PublicProfileField,
  PublicProfilePolicyV1,
} from '@happier-dev/protocol/account/publicProfile';
import { PUBLIC_PROFILE_FACT_FIELDS_V1 } from '@happier-dev/protocol/account/projectPublicProfile';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { t } from '@/text';

type Figure = PublicUsageMetricId;

/**
 * Each Totals figure's own eye on the owner's page (lab `ppcomp-E`): it flips exactly that figure's
 * field through the page's one consent owner. A figure visitors don't see stays in place, quieted.
 */
export function publicProfileFigureControls(
  input: Readonly<{
    policy: PublicProfilePolicyV1;
    disabled: boolean;
    onToggle: (field: PublicProfileField, shown: boolean) => void;
  }>,
): Pick<HappierPublicProfileOwner, 'renderFigureControl' | 'hiddenFigures'> {
  const { policy, disabled, onToggle } = input;
  const hiddenFigures = new Set(
    (Object.keys(PUBLIC_PROFILE_FACT_FIELDS_V1) as Figure[]).filter(
      (figure) => !policy.fields[PUBLIC_PROFILE_FACT_FIELDS_V1[figure]],
    ),
  );
  const renderFigureControl = (figure: Figure) => {
    const field = PUBLIC_PROFILE_FACT_FIELDS_V1[figure];
    const shown = policy.fields[field];
    const item = t(`publicIdentity.publicData.fields.${field}`);
    const label = shown
      ? t('publicIdentity.editor.hideItem', { item })
      : t('publicIdentity.editor.shareItem', { item });
    return (
      <IconButton
        testID={`public-profile-figure-eye-${figure}`}
        iconName={shown ? 'eye' : 'eye-slash'}
        accessibilityLabel={label}
        tooltip={label}
        variant="plain"
        // Small enough that a figure keeps its whole label beside it ("Best streak in this period").
        size={24}
        disabled={disabled}
        onPress={() => onToggle(field, !shown)}
      />
    );
  };
  return { renderFigureControl, hiddenFigures };
}
