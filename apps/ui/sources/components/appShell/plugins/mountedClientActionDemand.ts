import * as React from 'react';

import type { AppShellPluginUiProjectionPublication } from './appShellPluginUiProjectionPublication';
import type { PluginUiClientExecutableProjectionSource } from '@/components/plugins/reactNative/clientExecutableProjection';

/** Mounted admission feeds AppShell's existing executable owner, never a second reconciler. */
export const MountedClientActionDemandContext = React.createContext<
    AppShellPluginUiProjectionPublication['publishMountedActions'] | null
>(null);

export const EMPTY_MOUNTED_CLIENT_ACTION_PROJECTIONS: readonly PluginUiClientExecutableProjectionSource[] = Object.freeze([]);
