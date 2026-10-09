import * as React from 'react';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { t } from '@/text';
import { WidgetArea } from './WidgetArea';
import type { WidgetAreaPort } from './useWidgetAreaLayout';
import { useProjectWidgetAreaBinding, type ProjectWidgetAreaBindingInput } from './useProjectWidgetAreaBinding';
export { projectWidgetAreaContext, useProjectWidgetAreaBinding } from './useProjectWidgetAreaBinding';
export type { ProjectWidgetAreaValue, ProjectWidgetAreaBindingInput, ProjectWidgetAreaBinding } from './useProjectWidgetAreaBinding';

export type ProjectWidgetAreaProps = Readonly<{
    area?: 'main' | 'aside';
    /** The project's name, as its page header shows it ("Add to happier"). */
    projectName: string;
    /**
     * The area's operations for this project's personal layout, bound by the host to the captured
     * Home/Account and stable Project identity. `null` while that identity is not known: the
     * block then says so instead of offering a layout it cannot keep.
     */
    port: WidgetAreaPort | null;
    context: WidgetSurfaceContext;
    /** Why the captured layout binding is absent. A missing Source only leaves its input slot empty. */
    unavailableReasonCode?: string;
    testID: string;
}>;

/**
 * The Widgets block of a Project's Code aside (lab `dashboards` P1/P1p/P1a): one personal column per
 * project, order only and Plain by default, with the shared Gallery, Set up and frames. The Project
 * page (lane 12) places it — in the aside on a desktop, under the checkout row on a phone — and
 * supplies the port and the two slots; the block itself is the same on both.
 */
export function ProjectWidgetArea(props: ProjectWidgetAreaProps): React.ReactElement {
    const unavailable = React.useMemo(() => (props.port ? undefined : {
        title: t('widgetAdd.areaUnavailableTitle'),
        reasonCode: props.unavailableReasonCode ?? 'widget_project_identity_unavailable',
    }), [props.port, props.unavailableReasonCode]);
    return (
        <WidgetArea
            port={props.port}
            context={props.context}
            geometry="column"
            area={props.area}
            title={t('widgetAdd.areaProjectTitle')}
            meta={t('widgetAdd.areaProjectMeta')}
            surfaceName={props.projectName}
            {...(unavailable ? { unavailable } : {})}
            testID={props.testID}
        />
    );
}

/**
 * The Code aside consumes the same binding as Overview. Source-free Projects still have their
 * personal layout; an unavailable portable Source remains an empty follow-input slot.
 */
export function ProjectAsideWidgets(props: ProjectWidgetAreaBindingInput & Readonly<{
    testID: string;
}>): React.ReactElement {
    const binding = useProjectWidgetAreaBinding(props);
    return (
        <ProjectWidgetArea
            projectName={props.projectName}
            area="aside"
            {...binding}
            testID={props.testID}
        />
    );
}
