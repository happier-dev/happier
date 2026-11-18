import * as React from 'react';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { ReviewsListHost } from '@/components/reviews/ReviewsListHost';

export function ReviewsRoute(): React.ReactElement { return <ReviewsListHost />; }
export { ReviewsRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ReviewsRoute} />; }
