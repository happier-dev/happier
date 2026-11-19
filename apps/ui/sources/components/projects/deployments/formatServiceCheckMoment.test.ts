import { describe, expect, it } from 'vitest';

import { formatServiceCheckMoment } from './formatServiceCheckMoment';

describe('formatServiceCheckMoment', () => {
  it('keeps a time with its day period, so a narrow State cell never breaks "2:54 AM" (PAGE-ACCEPT-176 R4-D1)', () => {
    const at = new Date(2026, 10, 19, 2, 54).getTime();
    const sameDay = formatServiceCheckMoment(at, at + 60_000);
    const earlier = formatServiceCheckMoment(at, at + 3 * 86_400_000);
    for (const text of [sameDay, earlier]) {
      // A 12-hour locale joins the minutes and the day period with a non-breaking space; nothing breaks between them.
      expect(text).not.toMatch(/\d[ \t]+[AaPp]/);
    }
    expect(sameDay).toMatch(/2:54/);
  });
});
