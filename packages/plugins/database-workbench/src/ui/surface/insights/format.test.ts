import { describe, expect, it } from 'vitest';
import { displayDatabaseStatementShape } from './format.js';

describe('Statement shape display', () => {
  it('keeps comparison operators together in a normalized shape', () => {
    const shape = 'select a . pid from pg_stat_activity a where a . pid > = ? and a . state < > ? and a . pid < = ? and a . pid ! = ?';
    expect(displayDatabaseStatementShape(shape))
      .toBe('select a.pid from pg_stat_activity a where a.pid >= ? and a.state <> ? and a.pid <= ? and a.pid != ?');
  });

  it('keeps SQL punctuation and quoted names readable', () => {
    const shape = 'select a . pid : : text as key , count ( * ) from pg_stat_activity a where a . state in ( ? , ? ) group by a . pid';
    expect(displayDatabaseStatementShape(shape))
      .toBe('select a.pid::text as key, count(*) from pg_stat_activity a where a.state in (?, ?) group by a.pid');
    expect(displayDatabaseStatementShape('select "first name" , x . y from t')).toBe('select "first name", x.y from t');
  });
});
