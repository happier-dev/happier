import { z } from 'zod/mini';
import type { DeploymentSourceAdmission } from './deploymentAdmission';

/** Source admission already owns disclosure of this exact presentation metadata. */
export function projectDeploymentSourcePresentation(source: DeploymentSourceAdmission['source']): Pick<DeploymentSourceAdmission['source'], 'id' | 'name'> {
    return { id: source.id, name: source.name };
}

/** Presentation lists omit invalid stored rows; detail and mutation projections remain strict. */
export function projectDeploymentListRow<T>(project: () => T): T | null {
    try { return project(); }
    catch (error) {
        if (error instanceof z.core.$ZodError) return null;
        throw error;
    }
}
