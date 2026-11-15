import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { t } from '@/text';

import { DeploymentEnvironmentStateMark } from './deployments/rows/DeploymentEnvironmentRow';
import type { ProjectsTreeRow } from './projectsTreeRows';

/**
 * A Project or checkout row's end while something beneath it asks for a look (the Projects column and the phone list).
 * An Environment's trouble is that Environment's state mark (UI refinements ruling 2026-11-15 08:57Z), the same words
 * and tone the Services column says; a deploy at work yields to a checkout that needs the person, whose Session fact
 * keeps its quiet needs-you dot. Otherwise a working checkout spins.
 */
export function ProjectsTreeRowAttention(
  props: Readonly<{
    row: Pick<ProjectsTreeRow, 'attention' | 'state'>;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { attention } = props.row;
  const state = props.row.state ?? null;
  if (state && (state.tone !== null || attention !== 'needs-you')) {
    return (
      <DeploymentEnvironmentStateMark
        state={state}
        {...(props.testID ? { testID: `${props.testID}-state` } : {})}
      />
    );
  }
  if (attention === 'needs-you') {
    return (
      <StatusDot
        {...(props.testID ? { testID: `${props.testID}-needs-you` } : {})}
        color={theme.colors.state.warning.foreground}
        size={6}
        accessibilityLabel={t('projects.checkouts.needsYou')}
      />
    );
  }
  if (attention === 'working')
    return <ActivitySpinner size="small" color={theme.colors.text.tertiary} />;
  return null;
}
