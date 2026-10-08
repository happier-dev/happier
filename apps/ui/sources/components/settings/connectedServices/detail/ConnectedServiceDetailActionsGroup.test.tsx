import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, pressTestInstanceAsync } from '@/dev/testkit';
import { installConnectedServicesCommonModuleMocks } from '../connectedServicesTestHelpers';
import { ConnectedServiceDetailActionsGroup } from './ConnectedServiceDetailActionsGroup';

installConnectedServicesCommonModuleMocks();

describe('ConnectedServiceDetailActionsGroup import', () => {
    it('offers existing-login import as a separate action beside browser authorization', async () => {
        const onImport = vi.fn();
        const screen = await renderScreen(<ConnectedServiceDetailActionsGroup
            supportsOauth supportsToken={false} tokenKind={null}
            oauthAddActionModes={['paste']}
            onAddOauthProfile={vi.fn()} onConnectToken={vi.fn()} onOpenTokenSetupUrl={vi.fn()}
            onImport={onImport}
        />);
        await pressTestInstanceAsync(screen.tree.findByProps({ testID: 'connected-services-action:import' }));
        expect(onImport).toHaveBeenCalledOnce();
        expect(screen.tree.findByProps({ testID: 'connected-services-action:add-oauth-profile-paste' })).toBeTruthy();
    });
});
