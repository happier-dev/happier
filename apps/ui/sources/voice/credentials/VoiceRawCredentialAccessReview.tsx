import * as React from 'react';
import { View } from 'react-native';

import type {
  DaemonVoiceClientRawCredentialAuthorizationV1,
  DaemonVoiceClientRawCredentialReviewV1,
  PluginContributionIdentityV1,
  VoiceRawCredentialGrantDeclaration,
} from '@happier-dev/protocol';

import { PluginPermissionGrantSheet } from '@/components/plugins/permissions/PluginPermissionGrantSheet';
import { Item } from '@/components/ui/lists/Item';
import {
  createPluginPermissionGrantActions,
  type PluginPermissionGrantActions,
} from '@/sync/domains/plugins/permissions/actions';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import {
  selectPluginPermissionGrants,
  selectPluginPermissionPendingRequests,
} from '@/sync/domains/plugins/permissions/store';
import { usePluginPermissionGrants } from '@/sync/domains/plugins/permissions/usePluginPermissionGrants';
import { useSettingsVersion } from '@/sync/store/hooks';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  rawCredentialAuthorizationClient,
  type RawCredentialAuthorizationClient,
} from './rawCredentialAuthorizationClient';

type AuthorizationInspection = Readonly<{
  authorization: DaemonVoiceClientRawCredentialAuthorizationV1;
  review: DaemonVoiceClientRawCredentialReviewV1;
}>;

export type VoiceRawCredentialAccessReviewProps = Readonly<{
  contribution: PluginContributionIdentityV1;
  rawGrant: VoiceRawCredentialGrantDeclaration;
  client?: Pick<RawCredentialAuthorizationClient, 'inspect' | 'request'>;
  actions?: PluginPermissionGrantActions;
  testID?: string;
}>;

function sameAuthorization(
  left: DaemonVoiceClientRawCredentialAuthorizationV1,
  right: DaemonVoiceClientRawCredentialAuthorizationV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sourceDescription(
  source: DaemonVoiceClientRawCredentialAuthorizationV1['disclosures'][number]['sourceClass'],
): string {
  if (source.kind === 'savedSecret') {
    return `savedSecret(${source.secretKinds.join(', ')})`;
  }
  return `connectedAccount(${source.service.pluginId}/${source.service.localId})`;
}

export function createVoiceRawCredentialReviewDecisionBody(
  inspection: AuthorizationInspection,
): string {
  const { authorization, review } = inspection;
  const credentialSlot = `${review.credentialSlot.name} (${review.credentialSlot.id}; ${review.credentialSlot.purpose})`;
  return authorization.disclosures.map((disclosure) => t(
    'settingsVoice.externalCredentials.rawCredentialAccessReviewBody',
    {
      pluginId: review.contribution.identity.pluginId,
      localId: review.contribution.identity.localId,
      credentialSlot,
      source: sourceDescription(disclosure.sourceClass),
      realm: disclosure.realm,
      phase: disclosure.phase,
    },
  )).join('\n');
}

export function createVoiceRawCredentialReviewDetailRows(
  inspection: AuthorizationInspection,
): readonly Readonly<{ key: string; label?: string; value: string }>[] {
  const { authorization, review } = inspection;
  const publisher = review.publisher.status === 'bundled_first_party'
    ? review.publisher.identity
    : review.publisher.status === 'unverified'
      ? review.publisher.displayName
    : 'unavailable';
  const distribution = review.distribution.kind === 'npm'
    ? `${review.distribution.packageName} · ${review.distribution.registryOrigin}`
    : review.distribution.kind === 'path'
      ? review.distribution.development ? 'development path' : 'path'
      : review.distribution.kind;
  return Object.freeze([
    {
      key: 'package',
      value: t('settingsVoice.externalCredentials.recipientApprovalPackage', {
        title: review.plugin.name,
        pluginId: review.plugin.id,
        sourceKind: review.distribution.kind,
        sourceLocator: `${review.package.identity} · ${distribution}`,
      }),
    },
    {
      key: 'publisher',
      value: t('settingsVoice.externalCredentials.recipientApprovalPublisher', {
        trust: review.publisher.status,
        identity: publisher,
      }),
    },
    {
      key: 'package-signature',
      value: t('settingsVoice.externalCredentials.recipientApprovalPackageSignature', {
        status: review.packageSignature.status,
        keyId: review.packageSignature.status === 'verified'
          ? review.packageSignature.keyId
          : 'unavailable',
      }),
    },
    {
      key: 'contribution',
      value: t('settingsVoice.externalCredentials.recipientApprovalContribution', {
        pluginId: review.contribution.identity.pluginId,
        localId: review.contribution.identity.localId,
      }),
    },
    {
      key: 'credential-slot',
      label: t('pluginPermissions.fields.scope'),
      value: `${review.credentialSlot.name} (${review.credentialSlot.id}) · ${review.credentialSlot.purpose}`,
    },
    ...authorization.disclosures.map((disclosure, index) => ({
      key: `disclosure-${index}`,
      label: t('pluginPermissions.fields.capability'),
      value: [
        sourceDescription(disclosure.sourceClass),
        disclosure.realm,
        disclosure.phase,
        disclosure.materialization,
        disclosure.destination,
        disclosure.origin,
      ].filter((value): value is string => Boolean(value)).join(' · '),
    })),
  ]);
}

export function VoiceRawCredentialAccessReview(props: VoiceRawCredentialAccessReviewProps) {
  const client = props.client ?? rawCredentialAuthorizationClient;
  const defaultActions = React.useMemo(() => createPluginPermissionGrantActions({
    execute: createFrontDoorUiActionExecutor(),
  }), []);
  const actions = props.actions ?? defaultActions;
  const settingsVersion = useSettingsVersion();
  const [inspection, setInspection] = React.useState<AuthorizationInspection | null>(null);
  const [unavailable, setUnavailable] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const inspect = React.useCallback(async (signal?: AbortSignal): Promise<AuthorizationInspection | null> => {
    try {
      const response = await client.inspect(props.contribution, props.rawGrant, signal);
      const next = Object.freeze({
        authorization: response.authorization,
        review: response.review,
      });
      setInspection(next);
      setUnavailable(false);
      return next;
    } catch {
      if (signal?.aborted) return null;
      setInspection(null);
      setUnavailable(true);
      return null;
    }
  }, [client, props.contribution, props.rawGrant]);

  // The authorization subject is derived from account settings, so a settings
  // change invalidates the current inspection and the pending request rendered
  // for it. Re-derive rather than keeping a surface bound to the old account.
  React.useEffect(() => {
    const controller = new AbortController();
    void inspect(controller.signal);
    return () => controller.abort();
  }, [inspect, settingsVersion]);

  const listInput = React.useMemo(() => inspection ? ({
    pluginId: inspection.authorization.pluginId,
    capability: inspection.authorization.capability,
    targetScope: inspection.authorization.targetScope,
    subject: inspection.authorization.subject,
    includeRevoked: false,
    includeResolvedRequests: false,
    limit: 200,
  } as const) : null, [inspection]);
  const permissionGrants = usePluginPermissionGrants({
    actions,
    enabled: inspection !== null,
    listInput,
  });
  /**
   * Grants and requests are listed Account-wide so the management surfaces can
   * show every device's approval. This surface is not one of those: it acts for
   * the one selected daemon, so it must read, decide and revoke only the row
   * that daemon's own installation approved. Taking the first Account-wide
   * match would let one machine's approval read as this machine's, and would
   * revoke another device's grant.
   */
  const authorityIdentity = React.useMemo(() => inspection ? ({
    pluginId: inspection.authorization.pluginId,
    capability: inspection.authorization.capability,
    targetScope: inspection.authorization.targetScope,
    subject: inspection.authorization.subject,
    authoritySource: inspection.authorization.authoritySource,
  } as const) : null, [inspection]);
  const activeGrant = React.useMemo(() => authorityIdentity
    ? selectPluginPermissionGrants(permissionGrants.state, authorityIdentity)[0] ?? null
    : null, [authorityIdentity, permissionGrants.state]);
  const pendingRequest = React.useMemo(() => authorityIdentity
    ? selectPluginPermissionPendingRequests(permissionGrants.state, authorityIdentity)[0] ?? null
    : null, [authorityIdentity, permissionGrants.state]);
  const activeGrantId = activeGrant?.id ?? null;
  const isGranted = activeGrant !== null;
  const grantStateReady = permissionGrants.state.status === 'ready'
    || permissionGrants.state.status === 'refreshing';

  const onPress = React.useCallback(() => {
    if (busy) return;
    fireAndForget((async () => {
      setBusy(true);
      try {
        const current = await inspect();
        if (!current) return;
        if (!inspection || !sameAuthorization(current.authorization, inspection.authorization)) {
          return;
        }
        if (isGranted && activeGrantId) {
          await permissionGrants.revoke({ grantId: activeGrantId });
          return;
        }
        if (pendingRequest) return;
        const requested = await client.request(props.contribution, props.rawGrant);
        if (!sameAuthorization(requested.authorization, current.authorization)) {
          setInspection(Object.freeze({
            authorization: requested.authorization,
            review: requested.review,
          }));
          return;
        }
        permissionGrants.upsertPendingRequest({
          ...requested.pendingRequest,
          pluginName: requested.review.plugin.name,
        });
      } catch {
        setUnavailable(true);
      } finally {
        setBusy(false);
      }
    })(), { tag: `VoiceRawCredentialAccessReview.${props.contribution.pluginId}.${props.contribution.localId}` });
  }, [
    activeGrantId,
    busy,
    client,
    inspect,
    inspection,
    isGranted,
    pendingRequest,
    permissionGrants,
    props.contribution,
    props.rawGrant,
  ]);

  /**
   * A decision surface captures the exact authorization it was rendered for. An
   * account or settings switch can land between that render and the person's
   * tap, so every decision re-inspects first and is discarded when the
   * host-derived authorization it was shown for is no longer the current one.
   * Deciding a captured request would otherwise disclose raw credential access
   * for a subject the person never reviewed.
   */
  const decideReviewedPendingRequest = React.useCallback(async (
    decide: () => Promise<unknown> | unknown,
  ): Promise<void> => {
    const reviewed = inspection;
    if (!reviewed) return;
    const current = await inspect();
    if (!current) return;
    if (!sameAuthorization(current.authorization, reviewed.authorization)) return;
    await decide();
  }, [inspect, inspection]);

  const details = inspection ? createVoiceRawCredentialReviewDetailRows(inspection) : [];
  return (
    <View>
      <Item
        testID={props.testID}
        title={t('settingsVoice.externalCredentials.reviewRequired')}
        detail={unavailable
          ? t('settingsVoice.externalCredentials.unavailable')
          : permissionGrants.state.status === 'error'
            ? t('settingsVoice.externalCredentials.unavailable')
          : isGranted
            ? t('common.applied')
            : t('settingsVoice.externalCredentials.reviewRequired')}
        loading={!unavailable && (!inspection || !grantStateReady || busy)}
        disabled={unavailable || !inspection || !grantStateReady || busy}
        destructive={isGranted}
        onPress={onPress}
      />
      {inspection && pendingRequest ? (
        <PluginPermissionGrantSheet
          pendingRequest={pendingRequest}
          labels={{
            title: t('settingsVoice.externalCredentials.recipientApprovalTitle'),
            body: () => createVoiceRawCredentialReviewDecisionBody(inspection),
            grant: t('settingsVoice.externalCredentials.recipientApprovalConfirm'),
            dismiss: t('common.cancel'),
          }}
          detailRows={details}
          onGrant={(input) => {
            fireAndForget(
              decideReviewedPendingRequest(() => permissionGrants.grant(input)),
              { tag: `VoiceRawCredentialAccessReview.grant.${props.contribution.pluginId}.${props.contribution.localId}` },
            );
          }}
          onDismiss={(input) => {
            fireAndForget(
              decideReviewedPendingRequest(() => permissionGrants.dismissRequest(input)),
              { tag: `VoiceRawCredentialAccessReview.dismiss.${props.contribution.pluginId}.${props.contribution.localId}` },
            );
          }}
          disabled={busy}
          testID={props.testID ? `${props.testID}-sheet` : undefined}
        />
      ) : null}
    </View>
  );
}
