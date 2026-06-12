# Stress Test Schema Migration Guide

This document walks through implementing the stress test results schema in your project.

---

## Quick Start

### For Prisma-based Projects (Recommended)

1. **Add schema to your Prisma file**:
   ```bash
   cat stress_test_schema.prisma >> apps/server/prisma/schema.prisma
   ```

2. **Create migration**:
   ```bash
   cd apps/server
   yarn prisma migrate dev --name add_stress_test_schema
   ```

3. **Verify migration**:
   ```bash
   yarn prisma db seed  # If you have seed script
   ```

### For Pure PostgreSQL

1. **Apply DDL directly**:
   ```bash
   psql $DATABASE_URL -f stress_test_schema.sql
   ```

2. **Verify tables created**:
   ```bash
   psql $DATABASE_URL -c "\dt stress_test*"
   ```

---

## Detailed Implementation Steps

### Step 1: Backup Your Database

```bash
# Create a backup before any schema changes
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d_%H%M%S).sql
```

### Step 2: Choose Your Approach

#### Option A: Prisma Migration (Recommended for this project)

**Why Prisma?**
- Integrates with your existing schema
- Version-controlled migrations
- Type-safe Prisma client
- Automatic rollback capability
- Works across different databases

**Steps**:

1. Copy the Prisma models from `stress_test_schema.prisma`:

```prisma
// Add to apps/server/prisma/schema.prisma

// ==============================================================================
// STRESS TEST SCHEMA
// ==============================================================================

model StressTestRun {
  // ... (copy entire model from stress_test_schema.prisma)
}

model StressTestOperation {
  // ... (copy entire model from stress_test_schema.prisma)
}

model StressTestMetricsDaily {
  // ... (copy entire model from stress_test_schema.prisma)
}
```

2. Generate migration:
```bash
cd apps/server
yarn prisma migrate dev --name add_stress_test_schema
```

3. Prisma will:
   - Generate SQL DDL automatically
   - Create migration file in `prisma/migrations/`
   - Apply migration to your database
   - Generate updated Prisma client

4. Verify the migration file:
```bash
cat prisma/migrations/[timestamp]_add_stress_test_schema/migration.sql
```

#### Option B: Raw SQL Migration

If you're managing migrations manually:

1. Create migration file:
```bash
mkdir -p scripts/migrations
cp stress_test_schema.sql scripts/migrations/001_add_stress_test_schema.sql
```

2. Apply migration:
```bash
psql $DATABASE_URL -f scripts/migrations/001_add_stress_test_schema.sql
```

3. Track in version control:
```bash
git add scripts/migrations/001_add_stress_test_schema.sql
```

### Step 3: Generate Prisma Client

```bash
cd apps/server
yarn prisma generate
```

This creates TypeScript types for:
- `StressTestRun`
- `StressTestOperation`
- `StressTestMetricsDaily`

### Step 4: Test the Schema

Create a simple test to verify tables exist and are queryable:

```typescript
// test/schema-verification.spec.ts
import { prisma } from '@/storage/db';

describe('Stress Test Schema', () => {
  it('should have StressTestRun table', async () => {
    // This should not throw
    const count = await prisma.stressTestRun.count();
    expect(typeof count).toBe('number');
  });

  it('should have StressTestOperation table', async () => {
    const count = await prisma.stressTestOperation.count();
    expect(typeof count).toBe('number');
  });

  it('should have StressTestMetricsDaily table', async () => {
    const count = await prisma.stressTestMetricsDaily.count();
    expect(typeof count).toBe('number');
  });
});
```

Run tests:
```bash
yarn test
```

### Step 5: Create Initial Data

If needed, seed initial test data:

```typescript
// Optional: prisma/seed.ts or in your seed script
import { prisma } from '@/storage/db';

async function seedStressTestData() {
  const testRun = await prisma.stressTestRun.create({
    data: {
      testId: 'initial-test-run',
      startTime: new Date(),
      endTime: new Date(),
      totalDurationMs: 1000,
      bashCommandsExecuted: 0,
      filesCreated: 0,
      subagentsSpawned: 0,
      webSearchesPerformed: 0,
      successRate: 100.0,
      successfulOperations: 0,
      totalOperations: 0,
      environment: 'test',
      testName: 'Initial Test',
    },
  });

  console.log('✓ Seeded initial stress test data');
}
```

---

## Migration Validation

### Verify Tables Created

```bash
psql $DATABASE_URL -c "\dt stress_test*"
```

Expected output:
```
               List of relations
 Schema |             Name              | Type  | Owner
--------+-------------------------------+-------+-------
 public | stress_test_run               | table | user
 public | stress_test_operation         | table | user
 public | stress_test_metrics_daily     | table | user
(3 rows)
```

### Verify Indexes

```bash
psql $DATABASE_URL -c "\di stress_test*"
```

Expected output should show all indexes listed in the schema.

### Verify Constraints

```bash
psql $DATABASE_URL -c "SELECT table_name, constraint_name, constraint_type FROM information_schema.table_constraints WHERE table_name LIKE 'stress_test%' ORDER BY table_name, constraint_name;"
```

### Verify Foreign Keys

```bash
psql $DATABASE_URL -c "SELECT constraint_name, table_name, column_name FROM information_schema.key_column_usage WHERE table_name LIKE 'stress_test%' ORDER BY table_name, column_name;"
```

---

## Rollback Procedure

### If Using Prisma

If the migration fails or you need to rollback:

```bash
cd apps/server

# Rollback to previous state
yarn prisma migrate resolve --rolled-back [migration_name]

# Or reset database (development only)
yarn prisma migrate reset
```

### If Using Raw SQL

Create a rollback script:

```sql
-- scripts/migrations/001_add_stress_test_schema_rollback.sql
DROP TABLE IF EXISTS stress_test_operation CASCADE;
DROP TABLE IF EXISTS stress_test_run CASCADE;
DROP TABLE IF EXISTS stress_test_metrics_daily CASCADE;
DROP VIEW IF EXISTS stress_test_metrics_summary;
```

Apply rollback:
```bash
psql $DATABASE_URL -f scripts/migrations/001_add_stress_test_schema_rollback.sql
```

---

## Post-Migration Setup

### 1. Create Usage Examples

Copy `stress_test_examples.ts` to your codebase:

```bash
cp stress_test_examples.ts apps/server/sources/modules/stressTest/usage.ts
```

### 2. Create Service Module

Create a service to encapsulate stress test operations:

```typescript
// apps/server/sources/modules/stressTest/service.ts
import { prisma } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import type { StressTestInput } from './types';

export async function createStressTestRun(input: StressTestInput) {
  return await inTx(async () => {
    const durationMs =
      input.endTime.getTime() - input.startTime.getTime();

    return await prisma.stressTestRun.create({
      data: {
        startTime: input.startTime,
        endTime: input.endTime,
        totalDurationMs: durationMs,
        bashCommandsExecuted: input.bashCommandsExecuted,
        filesCreated: input.filesCreated,
        subagentsSpawned: input.subagentsSpawned,
        webSearchesPerformed: input.webSearchesPerformed,
        successRate: input.successRate,
        successfulOperations: input.successfulOperations,
        totalOperations: input.totalOperations,
        environment: input.environment || 'test',
        testName: input.testName,
        testVersion: input.testVersion,
      },
    });
  });
}

// ... (add other functions from stress_test_examples.ts)
```

### 3. Set Up Daily Metrics Job

Create a cron job to update daily metrics:

```typescript
// apps/server/sources/modules/stressTest/dailyMetricsJob.ts
import { prisma } from '@/storage/db';
import { inTx } from '@/storage/inTx';

export async function updateDailyMetrics() {
  return await inTx(async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const tomorrow = new Date(yesterday);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const metrics = await prisma.$queryRaw`
      -- Insert or update yesterday's metrics
      INSERT INTO stress_test_metrics_daily (
        date_utc, environment, total_runs, total_duration_ms_sum,
        total_bash_commands, total_files_created, total_subagents_spawned,
        total_web_searches, avg_success_rate, min_success_rate,
        max_success_rate, avg_duration_ms, min_duration_ms, max_duration_ms
      )
      SELECT
        DATE(${yesterday} AT TIME ZONE 'UTC'),
        environment,
        COUNT(*),
        SUM(total_duration_ms),
        SUM(bash_commands_executed),
        SUM(files_created),
        SUM(subagents_spawned),
        SUM(web_searches_performed),
        AVG(success_rate),
        MIN(success_rate),
        MAX(success_rate),
        AVG(total_duration_ms)::DECIMAL,
        MIN(total_duration_ms),
        MAX(total_duration_ms)
      FROM stress_test_run
      WHERE DATE(start_time AT TIME ZONE 'UTC') = DATE(${yesterday} AT TIME ZONE 'UTC')
      GROUP BY environment
      ON CONFLICT (date_utc, environment) DO UPDATE SET
        total_runs = EXCLUDED.total_runs,
        total_duration_ms_sum = EXCLUDED.total_duration_ms_sum,
        total_bash_commands = EXCLUDED.total_bash_commands,
        total_files_created = EXCLUDED.total_files_created,
        total_subagents_spawned = EXCLUDED.total_subagents_spawned,
        total_web_searches = EXCLUDED.total_web_searches,
        avg_success_rate = EXCLUDED.avg_success_rate,
        min_success_rate = EXCLUDED.min_success_rate,
        max_success_rate = EXCLUDED.max_success_rate,
        avg_duration_ms = EXCLUDED.avg_duration_ms,
        min_duration_ms = EXCLUDED.min_duration_ms,
        max_duration_ms = EXCLUDED.max_duration_ms,
        updated_at = NOW()
    `;

    return metrics;
  });
}
```

Register the cron job (using your project's scheduler):

```typescript
// In your app initialization
import { updateDailyMetrics } from '@/modules/stressTest/dailyMetricsJob';

// Schedule to run daily at 1 AM UTC
schedule('0 1 * * *', async () => {
  try {
    await updateDailyMetrics();
    console.log('✓ Daily stress test metrics updated');
  } catch (error) {
    console.error('✗ Failed to update daily metrics:', error);
  }
});
```

### 4. Create API Endpoints (Optional)

Add REST endpoints to expose stress test data:

```typescript
// apps/server/sources/apps/api/routes/stressTests.ts
import { fastify } from '@/app/api';
import { prisma } from '@/storage/db';
import { z } from 'zod';

const querySchema = z.object({
  hoursAgo: z.coerce.number().default(24),
  environment: z.string().optional(),
  limit: z.coerce.number().default(50),
});

fastify.get('/v1/stress-tests', async (request, reply) => {
  const { hoursAgo, environment, limit } = querySchema.parse(
    request.query
  );

  const cutoffTime = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);

  const tests = await prisma.stressTestRun.findMany({
    where: {
      startTime: { gte: cutoffTime },
      ...(environment && { environment }),
    },
    orderBy: { startTime: 'desc' },
    take: limit,
  });

  return reply.send(tests);
});

fastify.get<{ Params: { testId: string } }>(
  '/v1/stress-tests/:testId',
  async (request, reply) => {
    const test = await prisma.stressTestRun.findUnique({
      where: { testId: request.params.testId },
      include: {
        operations: {
          orderBy: { operationIndex: 'asc' },
        },
      },
    });

    if (!test) {
      return reply.status(404).send({ error: 'Test not found' });
    }

    return reply.send(test);
  }
);
```

---

## Monitoring and Maintenance

### Check Table Sizes

```bash
psql $DATABASE_URL -c "
  SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
  FROM pg_tables
  WHERE tablename LIKE 'stress_test%'
  ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
"
```

### Monitor Index Health

```bash
psql $DATABASE_URL -c "
  SELECT
    schemaname,
    tablename,
    indexname,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch
  FROM pg_stat_user_indexes
  WHERE tablename LIKE 'stress_test%'
  ORDER BY idx_scan DESC;
"
```

### Reindex if Needed

```bash
psql $DATABASE_URL -c "REINDEX TABLE stress_test_run;"
```

### Analyze Query Plans

```bash
psql $DATABASE_URL -c "
  EXPLAIN ANALYZE
  SELECT * FROM stress_test_run
  WHERE start_time >= NOW() - INTERVAL '24 hours'
  ORDER BY start_time DESC;
"
```

---

## Troubleshooting

### Migration Fails: "Table already exists"

This typically means:
1. Table was already created
2. Previous migration ran successfully

**Solution**:
```bash
# Check existing tables
psql $DATABASE_URL -c "\dt stress_test*"

# If tables exist, either:
# 1. Delete the migration file and re-create
# 2. Update migration to use IF NOT EXISTS
# 3. Reset database (development only): yarn prisma migrate reset
```

### Constraint Violation on Insert

If you get constraint violations:

```sql
-- Check constraint definitions
SELECT constraint_name, constraint_definition
FROM information_schema.check_constraints
WHERE table_name = 'stress_test_run';
```

Ensure your data satisfies:
- `success_rate` is between 0.0 and 100.0
- All count fields are >= 0
- `total_operations` >= `successful_operations`

### Performance Issues After Migration

Run optimization:

```bash
# Analyze tables
psql $DATABASE_URL -c "ANALYZE stress_test_run; ANALYZE stress_test_operation; ANALYZE stress_test_metrics_daily;"

# Reindex if needed
psql $DATABASE_URL -c "REINDEX INDEX CONCURRENTLY idx_stress_test_run_start_time;"

# Check query plans
EXPLAIN ANALYZE SELECT * FROM stress_test_run WHERE start_time >= NOW() - INTERVAL '24 hours';
```

---

## Summary

1. ✓ Backup database
2. ✓ Choose Prisma or SQL approach
3. ✓ Apply migrations
4. ✓ Verify schema created
5. ✓ Run tests
6. ✓ Set up service module
7. ✓ Create daily metrics job
8. ✓ Add API endpoints (optional)
9. ✓ Monitor performance

Your stress test schema is now ready to use!
