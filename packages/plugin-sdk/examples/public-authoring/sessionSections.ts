import {
    isPluginActionApprovalRequestCreated,
    type ActionApprovalRequestCreatedResult,
    type ActionsService,
    type PluginActionInputById,
    type PluginActionResultById,
} from '@happier-dev/plugin-sdk/actions';
import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';

export type ReviewSectionResult = ActionApprovalRequestCreatedResult | Readonly<{
    sections: PluginActionResultById['session.sections.list']['sections'];
    section: PluginActionResultById['session.sections.create']['section'];
    assignment: PluginActionResultById['session.section.set'];
}>;

/** The invocation's host Actions service owns Home, Account, policy and acknowledgement. */
export async function fileReviewSessionInNewSection(
    actions: Pick<ActionsService, 'execute'>,
    sessionId: string,
    input: PluginActionInputById['session.sections.create'],
    options?: PluginCancellationOptions,
): Promise<ReviewSectionResult> {
    const listed = await actions.execute('session.sections.list', {}, options);
    if (isPluginActionApprovalRequestCreated(listed)) return listed;
    const created = await actions.execute('session.sections.create', input, options);
    // An approval request is not an executed create. Let the host settle it before dependent work.
    if (isPluginActionApprovalRequestCreated(created)) return created;
    const assignment = await actions.execute('session.section.set', {
        sessionId, sectionId: created.section.sectionId,
    }, options);
    if (isPluginActionApprovalRequestCreated(assignment)) return assignment;
    return { sections: listed.sections, section: created.section, assignment };
}
