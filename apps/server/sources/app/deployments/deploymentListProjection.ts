import { z } from 'zod/mini';

/** Presentation lists omit invalid stored rows; detail and mutation projections remain strict. */
export function projectDeploymentListRow<T>(project: () => T): T | null {
    try { return project(); }
    catch (error) {
        if (error instanceof z.core.$ZodError) return null;
        throw error;
    }
}
