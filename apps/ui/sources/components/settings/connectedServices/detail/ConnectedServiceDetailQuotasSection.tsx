import * as React from 'react';

import { connectedServiceProfileKey, resolveConnectedServiceProfileLabel } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import type { ConnectedServiceId, ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import { ConnectedServiceQuotaCard } from '../ConnectedServiceQuotaCard';

type ConnectedServiceProfileLike = Readonly<{
  profileId?: string;
  status?: string;
}>;

export const ConnectedServiceDetailQuotasSection = React.memo(function ConnectedServiceDetailQuotasSection(props: Readonly<{
  serviceId: ConnectedServiceId;
  profiles: ReadonlyArray<ConnectedServiceProfileLike>;
  profileLabelsByKey: Readonly<Record<string, string>>;
  pinnedMeterIdsByKey: Readonly<Record<string, ReadonlyArray<string>>>;
  onSetPinnedMeterIds: (profileId: string, nextPinnedMeterIds: ReadonlyArray<string>) => void;
  onSnapshot: (key: string, snapshot: ConnectedServiceQuotaSnapshotV1 | null) => void;
}>) {
  return (
    <React.Fragment>
      {props.profiles
        .filter((p) => p?.status === 'connected')
        .map((p) => {
          const profileId = typeof p?.profileId === 'string' ? p.profileId : '';
          if (!profileId) return null;
          const label = resolveConnectedServiceProfileLabel({
            labelsByKey: props.profileLabelsByKey,
            serviceId: props.serviceId,
            profileId,
          });
          const key = connectedServiceProfileKey({ serviceId: props.serviceId, profileId });
          const pinnedMeterIds = props.pinnedMeterIdsByKey[key] ?? [];
          return (
            <ConnectedServiceQuotaCard
              key={`quota:${profileId}`}
              serviceId={props.serviceId}
              profileId={profileId}
              title={`Quotas${label ? ` — ${label}` : ` — ${profileId}`}`}
              pinnedMeterIds={pinnedMeterIds}
              onSetPinnedMeterIds={(next) => props.onSetPinnedMeterIds(profileId, next)}
              onSnapshot={(snapshot) => props.onSnapshot(key, snapshot)}
            />
          );
        })}
    </React.Fragment>
  );
});

