import type * as React from 'react';
import type { MainAppTabBar } from './bars/MainAppTabBar';
import type { SessionCockpitTabBar } from './bars/SessionCockpitTabBar';
import type { ProjectCockpitTabBar } from './bars/ProjectCockpitTabBar';
import type { DiscussionCockpitTabBar } from './bars/DiscussionCockpitTabBar';
import type { MachineCockpitTabBar } from './bars/MachineCockpitTabBar';
import type { WorkflowCockpitTabBar } from '@/components/workflows/navigation/WorkflowNavigationViews';
import type { EnvironmentCockpitTabBar } from '@/components/projects/deployments/EnvironmentNavigationViews';
import type { PluginDetailCockpitTabBar } from '@/components/plugins/pages/PluginDetailNavigationViews';

export type SystemMobileBottomChromeModel =
    | Readonly<{ kind: 'mainAppTabs'; props: React.ComponentProps<typeof MainAppTabBar> }>
    | Readonly<{ kind: 'sessionCockpit'; props: React.ComponentProps<typeof SessionCockpitTabBar> }>
    | Readonly<{ kind: 'projectCockpit'; props: React.ComponentProps<typeof ProjectCockpitTabBar> }>
    | Readonly<{ kind: 'discussionCockpit'; props: React.ComponentProps<typeof DiscussionCockpitTabBar> }>
    | Readonly<{ kind: 'machineCockpit'; props: React.ComponentProps<typeof MachineCockpitTabBar> }>
    | Readonly<{ kind: 'environmentCockpit'; props: React.ComponentProps<typeof EnvironmentCockpitTabBar> }>
    | Readonly<{ kind: 'pluginCockpit'; props: React.ComponentProps<typeof PluginDetailCockpitTabBar> }>
    | Readonly<{ kind: 'workflowCockpit'; props: React.ComponentProps<typeof WorkflowCockpitTabBar> }>;
