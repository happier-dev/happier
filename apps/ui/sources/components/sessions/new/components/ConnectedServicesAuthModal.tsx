import * as React from 'react';
import { View } from 'react-native';

import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/StyledText';
import { t } from '@/text';
import { resolveConnectedServiceDefaultProfileId } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';

import { useConnectedServiceQuotaBadges } from '@/hooks/server/connectedServices/useConnectedServiceQuotaBadges';
import { ConnectedServiceQuotaBadgesView } from '@/components/settings/connectedServices/ConnectedServiceQuotaBadgesView';

export type ConnectedServicesProfileOption = Readonly<{
  profileId: string;
  status: 'connected' | 'needs_reauth';
  providerEmail?: string | null;
  label?: string | null;
}>;

export type ConnectedServicesServiceBinding = Readonly<{
  source: 'native' | 'connected';
  profileId?: string;
}>;

export const CONNECTED_SERVICES_BINDINGS_KEY = 'connectedServicesBindingsByServiceId';

export const ConnectedServicesAuthModal = React.memo(function ConnectedServicesAuthModal(props: Readonly<{
  onClose: () => void;
  supportedServiceIds: ReadonlyArray<string>;
  profileOptionsByServiceId: Readonly<Record<string, ReadonlyArray<ConnectedServicesProfileOption>>>;
  bindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
  setBindingForService: (serviceId: string, binding: ConnectedServicesServiceBinding) => void;
  defaultProfileIdByServiceId?: Readonly<Record<string, string | undefined>>;
  onOpenSettings?: () => void;
}>) {
  const [bindingsByServiceId, setBindingsByServiceId] = React.useState<Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>>(
    props.bindingsByServiceId,
  );

  React.useEffect(() => {
    setBindingsByServiceId(props.bindingsByServiceId);
  }, [props.bindingsByServiceId]);

  const requestedProfiles = React.useMemo(() => {
    const next: Array<{ serviceId: string; profileId: string }> = [];
    for (const serviceId of props.supportedServiceIds) {
      const options = props.profileOptionsByServiceId[serviceId] ?? [];
      for (const opt of options) {
        if (opt.status !== 'connected') continue;
        const profileId = String(opt.profileId ?? '').trim();
        if (!profileId) continue;
        next.push({ serviceId, profileId });
      }
    }
    return next;
  }, [props.supportedServiceIds, props.profileOptionsByServiceId]);

  const quotaBadgesByKey = useConnectedServiceQuotaBadges(requestedProfiles);

  const handleSetBindingForService = React.useCallback((serviceId: string, binding: ConnectedServicesServiceBinding) => {
    setBindingsByServiceId((prev) => ({ ...prev, [serviceId]: binding }));
    props.setBindingForService(serviceId, binding);
  }, [props.setBindingForService]);

  return (
    <ItemList>
      {props.supportedServiceIds.map((serviceId) => {
        const options = props.profileOptionsByServiceId[serviceId] ?? [];
        const connected = options.filter((o) => o.status === 'connected');
        const current = bindingsByServiceId[serviceId] ?? { source: 'native' as const };
        const connectedIds = connected.map((o) => o.profileId);
        const explicit = (current.profileId ?? '').trim();
        const effectiveProfileId = explicit && connectedIds.includes(explicit)
          ? explicit
          : resolveConnectedServiceDefaultProfileId({
            serviceId,
            connectedProfileIds: connectedIds,
            defaultProfileByServiceId: props.defaultProfileIdByServiceId ?? {},
          }) ?? connected[0]?.profileId ?? '';
        const mode = current.source === 'connected' ? 'connected' : 'native';

        return (
          <ItemGroup key={serviceId} title={serviceId}>
            <Item
              title={'Backend native auth'}
              subtitle={'Use your local CLI login / API keys'}
              icon={<Ionicons name={mode === 'native' ? 'checkmark-circle' : 'ellipse-outline'} size={22} color="#007AFF" />}
              onPress={() => handleSetBindingForService(serviceId, { source: 'native' })}
              showChevron={false}
            />
            <Item
              title={'Use connected services'}
              subtitle={'Fetch and materialize from Happier cloud'}
              icon={<Ionicons name={mode === 'connected' ? 'checkmark-circle' : 'ellipse-outline'} size={22} color="#007AFF" />}
              onPress={() => {
                if (connected.length === 0) {
                  props.onOpenSettings?.();
                  return;
                }
                handleSetBindingForService(serviceId, { source: 'connected', profileId: effectiveProfileId });
              }}
              showChevron={connected.length === 0}
            />

            {mode === 'connected' ? (
              connected.length === 0 ? (
                <Item
                  title={'Not connected'}
                  subtitle={'Tap to open settings'}
                  icon={<Ionicons name="warning-outline" size={20} color="#FF9500" />}
                  onPress={props.onOpenSettings}
                />
              ) : (
                <View>
                  <Text style={{ marginLeft: 16, marginBottom: 6, opacity: 0.7 }}>{'Profile'}</Text>
                  {connected.map((opt) => {
                    const profileKey = connectedServiceProfileKey({ serviceId, profileId: opt.profileId });
                    const badges = quotaBadgesByKey[profileKey] ?? [];

                    return (
                      <Item
                        key={`${serviceId}:${opt.profileId}`}
                        title={(opt.label ?? '').trim() || opt.profileId}
                        subtitle={
                          (opt.label ?? '').trim()
                            ? `${opt.profileId}${opt.providerEmail ? ` • ${opt.providerEmail}` : ''}`
                            : opt.providerEmail ?? undefined
                        }
                        icon={
                          <Ionicons
                            name={effectiveProfileId === opt.profileId ? 'checkmark-circle' : 'ellipse-outline'}
                            size={20}
                            color="#007AFF"
                          />
                        }
                        rightElement={badges.length > 0 ? <ConnectedServiceQuotaBadgesView badges={badges} /> : undefined}
                        onPress={() => handleSetBindingForService(serviceId, { source: 'connected', profileId: opt.profileId })}
                        showChevron={false}
                      />
                    );
                  })}
                </View>
              )
            ) : null}
          </ItemGroup>
        );
      })}

      <ItemGroup>
        <Item
          title={t('common.close') ?? 'Done'}
          icon={<Ionicons name="close-outline" size={22} color="#007AFF" />}
          onPress={props.onClose}
          showChevron={false}
        />
      </ItemGroup>
    </ItemList>
  );
});
