import * as React from 'react';
import type { JsonValue } from '@happier-dev/protocol';

import type { WidgetSurfaceContext, WidgetSurfaceContextSlot } from '@/components/widgets/surface/widgetSurfaceSetup';
import { readProjectWidgetAreaContextV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import { t } from '@/text';

import { WidgetArea } from './WidgetArea';
import type { WidgetAreaPort } from './useWidgetAreaLayout';

/** One value the Project page fills, named for people ("happier-dev/happier", "MacBook Pro · main"). */
export type ProjectWidgetAreaValue = Readonly<{ value: JsonValue; label: string; description?: string }>;

/**
 * What a Project's widgets follow (lab `dashboards` P1, Q4): repository-wide inputs follow
 * "This project" (its portable source); checkout-local inputs follow "This checkout", the page's
 * checkout chip. A slot the page cannot fill yet is never followed, so its input is asked for.
 */
export function projectWidgetAreaContext(input: Readonly<{
    project: ProjectWidgetAreaValue | null;
    checkout: ProjectWidgetAreaValue | null;
}>): WidgetSurfaceContext {
    const slot = (label: string, value: ProjectWidgetAreaValue | null): WidgetSurfaceContextSlot => ({ label, value });
    return { slots: { project: slot(t('widgetAdd.thisProject'), input.project), checkout: slot(t('widgetAdd.thisCheckout'), input.checkout) } };
}

export type ProjectWidgetAreaProps = Readonly<{
    /** The project's name, as its page header shows it ("Add to happier"). */
    projectName: string;
    /**
     * The area's operations for this project's personal layout, bound by the host to the captured
     * Home/Account and the project's portable source. `null` while that source is not known: the
     * block then says so instead of offering a layout it cannot keep.
     */
    port: WidgetAreaPort | null;
    context: WidgetSurfaceContext;
    /** Why `port` is absent (`widget_project_source_unavailable`). */
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
        // One sentence that says what would bring them, not the mechanism behind it.
        title: t('widgetAdd.projectSourceUnavailableTitle'),
        reasonCode: props.unavailableReasonCode ?? 'widget_project_source_unavailable',
    }), [props.port, props.unavailableReasonCode]);
    return (
        <WidgetArea
            port={props.port}
            context={props.context}
            geometry="column"
            title={t('widgetAdd.areaProjectTitle')}
            meta={t('widgetAdd.areaProjectMeta')}
            surfaceName={props.projectName}
            {...(unavailable ? { unavailable } : {})}
            testID={props.testID}
        />
    );
}

/**
 * The aside adapter the Project page mounts today. Lane 12 has not published its portable Project
 * Source producer, and an exact checkout is not that source (`readProjectWidgetAreaContextV1`), so
 * the block truthfully reports the source as unavailable rather than keeping a layout under a
 * guessed identity. Once the producer exists, the page passes its source here and this adapter
 * binds the area's port to it; the block, slots and composition stay as they are.
 */
export function ProjectAsideWidgets(props: Readonly<{
    serverId: string;
    projectName: string;
    /** The page's exact checkout (`WorkspaceRefV1`) behind its checkout chip. */
    activeCheckout?: unknown;
    /** Its name on the chip ("MacBook Pro · main"). */
    activeCheckoutLabel?: string;
    testID: string;
}>): React.ReactElement {
    const read = React.useMemo(
        () => readProjectWidgetAreaContextV1({ serverId: props.serverId, activeCheckout: props.activeCheckout }),
        [props.activeCheckout, props.serverId],
    );
    const context = React.useMemo(() => {
        const checkout = read.providedContext.checkout?.[0];
        return projectWidgetAreaContext({
            project: null,
            checkout: checkout !== undefined ? { value: checkout, label: props.activeCheckoutLabel ?? props.projectName } : null,
        });
    }, [props.activeCheckoutLabel, props.projectName, read]);
    return (
        <ProjectWidgetArea
            projectName={props.projectName}
            port={null}
            context={context}
            unavailableReasonCode={read.reasonCode}
            testID={props.testID}
        />
    );
}
