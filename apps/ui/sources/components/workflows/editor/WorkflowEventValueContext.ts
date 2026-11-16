import * as React from 'react';

import type { WorkflowValueContext } from './workflowConditionValueOptions';

/** Ephemeral declarations from the mounted trigger owner, shared by Insert, '@' and conditions. */
export const WorkflowEventValueContext = React.createContext<WorkflowValueContext | undefined>(undefined);
