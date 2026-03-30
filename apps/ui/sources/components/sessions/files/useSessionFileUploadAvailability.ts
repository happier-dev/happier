import { useSessionFileTransferAvailability } from './useSessionFileTransferAvailability';

export function useSessionFileUploadAvailability(sessionId: string): boolean {
    return useSessionFileTransferAvailability(sessionId);
}
