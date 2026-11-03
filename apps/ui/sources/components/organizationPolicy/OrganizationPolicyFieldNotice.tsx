import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import type {
  OrganizationPolicyField,
  OrganizationPolicyLock,
} from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';

import { EmptyState } from '@/components/ui/empty/EmptyState';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useOpenExternalUrl } from '@/hooks/ui/useOpenExternalUrl';
import {
  getOrganizationPolicyFieldLock,
  readOrganizationPolicy,
} from '@/sync/domains/organizationPolicy/organizationPolicy';
import { t } from '@/text';

/** Presentation of the startup policy owner's result; mutation admission remains with the domain. */
export function readOrganizationPolicyFieldState(
  field: OrganizationPolicyField,
): Readonly<{
  disabled: boolean;
  accessibilityHint: string | undefined;
  lock: OrganizationPolicyLock | null;
}> {
  const result = readOrganizationPolicy();
  const lock = getOrganizationPolicyFieldLock(field);
  const accessibilityHint =
    result.status === 'invalid'
      ? t('organizationPolicy.invalidBody')
      : lock
        ? `${t('organizationPolicy.managedBy', { organization: lock.organization })}. ${t('organizationPolicy.lockedExplanation')}`
        : undefined;
  return {
    disabled: result.status === 'invalid' || lock !== null,
    accessibilityHint,
    lock,
  };
}

/**
 * The one "managed by your organization" affordance: a quiet line beside the value it governs,
 * with the administrator's help link when the policy names one. Consumers show the managed value
 * itself and leave out choices that cannot succeed, so this line never sits next to a dead control.
 */
export function OrganizationPolicyManagedLine(
  props: Readonly<{ lock: OrganizationPolicyLock; testID?: string }>,
) {
  const label = t('organizationPolicy.managedBy', {
    organization: props.lock.organization,
  });
  return (
    <View testID={props.testID} style={styles.line}>
      <Text
        style={styles.label}
        accessibilityLabel={`${label}. ${t('organizationPolicy.lockedExplanation')}`}
      >
        {label}
      </Text>
      {props.lock.supportUrl ? (
        <>
          <Text
            style={styles.label}
            importantForAccessibility="no"
            accessibilityElementsHidden
          >
            ·
          </Text>
          <SupportLink
            url={props.lock.supportUrl}
            testID={props.testID ? `${props.testID}-support` : undefined}
          />
        </>
      ) : null}
    </View>
  );
}

/**
 * `rows` places the same line on a list's or rail's row edge (where an add row would be), through
 * the shared quiet-line state; `inline` sits in a form or panel's own flow.
 */
export function OrganizationPolicyFieldNotice(
  props: Readonly<{ field: OrganizationPolicyField; placement?: 'inline' | 'rows' }>,
) {
  const lock = getOrganizationPolicyFieldLock(props.field);
  if (!lock) return null;
  const testID = `organization-policy-${props.field}`;
  if (props.placement === 'rows') return <ManagedRowsLine lock={lock} testID={testID} />;
  return <OrganizationPolicyManagedLine lock={lock} testID={testID} />;
}

/** On a narrow rail the help link would wrap away from its line; the managed surfaces it leads to offer it. */
function ManagedRowsLine(props: Readonly<{ lock: OrganizationPolicyLock; testID: string }>) {
  return (
    <EmptyState
      testID={props.testID}
      layout="line"
      title={t('organizationPolicy.managedBy', { organization: props.lock.organization })}
    />
  );
}

/**
 * A whole surface whose only purpose the policy governs (adding a Home when the Home is fixed): it
 * says who manages it in the action's place, offers the administrator's help, and keeps the way out.
 */
export function OrganizationPolicyManagedState(props: Readonly<{
    field: OrganizationPolicyField;
    testID?: string;
    closeLabel: string;
    closeTestID?: string;
    onClose: () => void;
}>) {
    const result = readOrganizationPolicy();
    const lock = getOrganizationPolicyFieldLock(props.field);
    const [, openSupport] = useOpenExternalUrl(lock?.supportUrl ?? '');
    const close = { label: props.closeLabel, onPress: props.onClose, testID: props.closeTestID };
    return (
        <EmptyState
            testID={props.testID}
            layout="page"
            iconName="house"
            title={lock ? t('organizationPolicy.managedBy', { organization: lock.organization }) : t('organizationPolicy.invalidTitle')}
            subtitle={lock ? t('organizationPolicy.lockedExplanation') : result.status === 'invalid' ? t('organizationPolicy.invalidBody') : undefined}
            primaryAction={lock?.supportUrl ? { label: t('organizationPolicy.support'), onPress: openSupport, testID: props.testID ? `${props.testID}-support` : undefined } : close}
            {...(lock?.supportUrl ? { secondaryAction: close } : {})}
        />
    );
}

function SupportLink(props: Readonly<{ url: string; testID?: string }>) {
  const [, open] = useOpenExternalUrl(props.url);
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="link"
      accessibilityLabel={t('organizationPolicy.support')}
      onPress={open}
    >
      <Text style={styles.support}>{t('organizationPolicy.support')}</Text>
    </HappierPressable>
  );
}

/** A broken native policy affects governed actions, while the rest of the app stays usable. */
export function OrganizationPolicyDiagnostic() {
  const result = readOrganizationPolicy();
  if (result.status !== 'invalid') return null;
  return (
    <AttentionBanner
      testID="organization-policy-invalid"
      presentation="strip"
      placement="inline"
      tone="danger"
      announce="alert"
      title={t('organizationPolicy.invalidTitle')}
      description={t('organizationPolicy.invalidBody')}
      details={[`${result.error.path}: ${result.error.code}`]}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  line: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: theme.space.s6,
  },
  label: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
  support: {
    ...Typography.variant('meta', 'medium'),
    color: theme.colors.text.link,
  },
}));
