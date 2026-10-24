import { JsonlRecordTooLargeError } from '@/api/directSessions/filePaging/jsonlReadBudget';
import { logger } from '@/utils/logger';

/** Titles are advisory bounded scans; an unread record must not hide the session. */
export async function readDirectSessionTitlePage<T>(readPage: () => Promise<T>): Promise<T | null> {
  try {
    return await readPage();
  } catch (error) {
    if (!(error instanceof JsonlRecordTooLargeError)) throw error;
    logger.warn(`[directSessions] Title scan stopped: ${error.message}`);
    return null;
  }
}
