# Stress Test Results Schema Design

## Overview

This schema is designed to store comprehensive stress test results with support for:
- **Temporal queries** by start/end time and date ranges
- **Metric aggregation** across multiple dimensions
- **Performance optimization** through denormalization and indexes
- **Operational details** for granular analysis and debugging

---

## Schema Components

### 1. `stress_test_run` (Core Table)

**Purpose**: Stores the main stress test result record with aggregated metrics.

| Column | Type | Purpose | Indexed |
|--------|------|---------|---------|
| `id` | `BIGSERIAL PRIMARY KEY` | Unique identifier | ✓ (implicit) |
| `test_id` | `UUID UNIQUE` | Business identifier for referencing tests | ✓ |
| `start_time` | `TIMESTAMP WITH TIME ZONE NOT NULL` | When the test began | ✓ |
| `end_time` | `TIMESTAMP WITH TIME ZONE NOT NULL` | When the test ended | ✓ |
| `total_duration_ms` | `INTEGER NOT NULL` | Duration in milliseconds (end - start) | — |
| `bash_commands_executed` | `INTEGER NOT NULL` | Count of bash commands run | — |
| `files_created` | `INTEGER NOT NULL` | Count of files created | — |
| `subagents_spawned` | `INTEGER NOT NULL` | Count of subagents spawned | — |
| `web_searches_performed` | `INTEGER NOT NULL` | Count of web searches performed | — |
| `success_rate` | `DECIMAL(5, 2) NOT NULL` | Success rate as percentage (0.0-100.0) | ✓ (partial index) |
| `successful_operations` | `INTEGER NOT NULL` | Count of successful operations | — |
| `total_operations` | `INTEGER NOT NULL` | Total operations attempted | — |
| `bash_success_count` | `INTEGER NOT NULL DEFAULT 0` | Successful bash commands | — |
| `subagent_success_count` | `INTEGER NOT NULL DEFAULT 0` | Successful subagent calls | — |
| `environment` | `VARCHAR(50) DEFAULT 'test'` | Deployment environment | ✓ |
| `test_name` | `VARCHAR(255)` | Human-readable test name | — |
| `test_version` | `VARCHAR(50)` | Test version/iteration | — |
| `created_at` | `TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()` | Record creation time | ✓ |
| `updated_at` | `TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()` | Last update time | — |

**Key Design Decisions**:
- **Denormalized metrics**: All aggregated data stored in the main table for fast queries without joins
- **UUID test_id**: Business identifier, separate from auto-increment `id` for distributed systems
- **Stored duration**: `total_duration_ms` computed once and stored for index efficiency
- **Success tracking**: Both percentage (`success_rate`) and counts (`successful_operations`, `total_operations`) for flexibility

---

### 2. `stress_test_operation` (Detail Table)

**Purpose**: Optional table for tracking individual operations within a test for granular analysis.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | `BIGSERIAL PRIMARY KEY` | Unique operation identifier |
| `test_run_id` | `BIGINT NOT NULL FK` | Foreign key to `stress_test_run` |
| `operation_type` | `VARCHAR(50) NOT NULL` | Type of operation (enum-like) |
| `operation_index` | `INTEGER NOT NULL` | Sequential order within test |
| `operation_label` | `VARCHAR(255)` | Human-readable operation name |
| `start_time` | `TIMESTAMP WITH TIME ZONE NOT NULL` | Operation start time |
| `end_time` | `TIMESTAMP WITH TIME ZONE NOT NULL` | Operation end time |
| `duration_ms` | `INTEGER NOT NULL` | Operation duration in milliseconds |
| `success` | `BOOLEAN NOT NULL` | Whether operation succeeded |
| `error_message` | `TEXT` | Error details if failed |
| `metadata` | `JSONB` | Operation-specific data (flexible structure) |
| `created_at` | `TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()` | Record creation time |

**Uses**:
- Debugging specific operations that failed
- Performance profiling of individual operations
- Analyzing operation-type patterns across test runs

---

### 3. `stress_test_metrics_daily` (Aggregation Table)

**Purpose**: Pre-aggregated daily metrics for fast dashboard and reporting queries.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | `BIGSERIAL PRIMARY KEY` | Unique identifier |
| `date_utc` | `DATE NOT NULL` | UTC date for grouping |
| `environment` | `VARCHAR(50) NOT NULL` | Environment identifier |
| `total_runs` | `INTEGER NOT NULL DEFAULT 0` | Number of tests run that day |
| `total_duration_ms_sum` | `BIGINT NOT NULL DEFAULT 0` | Sum of all durations |
| `total_bash_commands` | `INTEGER NOT NULL DEFAULT 0` | Total bash commands across all tests |
| `total_files_created` | `INTEGER NOT NULL DEFAULT 0` | Total files across all tests |
| `total_subagents_spawned` | `INTEGER NOT NULL DEFAULT 0` | Total subagents across all tests |
| `total_web_searches` | `INTEGER NOT NULL DEFAULT 0` | Total web searches across all tests |
| `avg_success_rate` | `DECIMAL(5, 2) NOT NULL DEFAULT 0.0` | Average success rate |
| `min_success_rate` | `DECIMAL(5, 2)` | Minimum success rate that day |
| `max_success_rate` | `DECIMAL(5, 2)` | Maximum success rate that day |
| `avg_duration_ms` | `DECIMAL(12, 2)` | Average test duration |
| `min_duration_ms` | `INTEGER` | Fastest test |
| `max_duration_ms` | `INTEGER` | Slowest test |
| `created_at` | `TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()` | Record creation time |
| `updated_at` | `TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()` | Last update time |

**Maintenance**:
- Update daily via a scheduled job (e.g., midnight UTC)
- Unique constraint on `(date_utc, environment)` prevents duplicates
- Can be recreated from `stress_test_run` as needed

---

## Indexes

### Primary Query Patterns

#### 1. Recent Tests Query
```sql
SELECT * FROM stress_test_run
WHERE start_time >= NOW() - INTERVAL '24 hours'
ORDER BY start_time DESC;
```
**Index**: `idx_stress_test_run_start_time` (start_time DESC)

#### 2. Date Range Query
```sql
SELECT * FROM stress_test_run
WHERE start_time >= $1 AND end_time <= $2
ORDER BY start_time DESC;
```
**Index**: `idx_stress_test_run_date_range` (start_time, end_time)

#### 3. Environment-Specific Aggregation
```sql
SELECT environment, COUNT(*), AVG(success_rate)
FROM stress_test_run
WHERE start_time >= NOW() - INTERVAL '7 days'
GROUP BY environment;
```
**Index**: `idx_stress_test_run_date_env` (start_time DESC, environment)

#### 4. Failed Tests
```sql
SELECT * FROM stress_test_run
WHERE success_rate < 100.0
ORDER BY created_at DESC;
```
**Index**: `idx_stress_test_run_failed` (created_at DESC) WHERE success_rate < 100.0

### Index Summary

| Index Name | Columns | Type | Use Case |
|------------|---------|------|----------|
| `idx_stress_test_run_start_time` | start_time DESC | B-tree | Recent tests, time-based sorting |
| `idx_stress_test_run_date_range` | (start_time, end_time) | B-tree | Date range queries |
| `idx_stress_test_run_test_id` | test_id | B-tree | Direct test lookups |
| `idx_stress_test_run_created_at` | created_at DESC | B-tree | Creation-time ordering |
| `idx_stress_test_run_date_env` | (start_time DESC, environment) | B-tree | Time-range + environment filters |
| `idx_stress_test_run_environment` | (environment, created_at DESC) | B-tree | Environment-specific trends |
| `idx_stress_test_run_failed` | created_at DESC (partial) | B-tree | Failed test reporting |

---

## Query Examples

### 1. Get All Tests from Last 24 Hours
```sql
SELECT * FROM stress_test_run
WHERE start_time >= NOW() - INTERVAL '24 hours'
ORDER BY start_time DESC;
```

### 2. Get Metrics for a Specific Date Range
```sql
SELECT
    DATE(start_time AT TIME ZONE 'UTC') AS date_utc,
    environment,
    COUNT(*) AS total_tests,
    AVG(success_rate) AS avg_success_rate,
    AVG(total_duration_ms) AS avg_duration_ms,
    SUM(bash_commands_executed) AS total_bash_commands,
    SUM(files_created) AS total_files_created,
    SUM(subagents_spawned) AS total_subagents,
    SUM(web_searches_performed) AS total_web_searches
FROM stress_test_run
WHERE start_time >= '2026-06-01' AND start_time < '2026-06-11'
GROUP BY DATE(start_time AT TIME ZONE 'UTC'), environment
ORDER BY date_utc DESC, environment;
```

### 3. Find Failed Tests with Details
```sql
SELECT
    test_id,
    test_name,
    test_version,
    environment,
    start_time,
    end_time,
    total_duration_ms,
    success_rate,
    successful_operations,
    total_operations
FROM stress_test_run
WHERE success_rate < 100.0
ORDER BY created_at DESC
LIMIT 50;
```

### 4. Performance Trends Over Time
```sql
SELECT
    DATE(start_time AT TIME ZONE 'UTC') AS date_utc,
    environment,
    MIN(total_duration_ms) AS fastest_test_ms,
    AVG(total_duration_ms) AS avg_duration_ms,
    MAX(total_duration_ms) AS slowest_test_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_duration_ms) AS p95_duration_ms,
    COUNT(*) AS test_count
FROM stress_test_run
WHERE start_time >= NOW() - INTERVAL '30 days'
GROUP BY DATE(start_time AT TIME ZONE 'UTC'), environment
ORDER BY date_utc DESC, environment;
```

### 5. Operation-Level Breakdown for a Specific Test
```sql
SELECT
    operation_type,
    COUNT(*) AS operation_count,
    SUM(CASE WHEN success THEN 1 ELSE 0 END) AS successful_count,
    AVG(duration_ms) AS avg_duration_ms,
    MAX(duration_ms) AS max_duration_ms,
    SUM(duration_ms) AS total_duration_ms
FROM stress_test_operation
WHERE test_run_id = (
    SELECT id FROM stress_test_run WHERE test_id = 'YOUR_TEST_ID'
)
GROUP BY operation_type
ORDER BY operation_type;
```

### 6. Environment Comparison
```sql
SELECT
    environment,
    COUNT(*) AS total_tests,
    AVG(success_rate) AS avg_success_rate,
    STDDEV_POP(success_rate) AS stddev_success_rate,
    AVG(total_duration_ms) AS avg_duration_ms,
    COUNT(CASE WHEN success_rate = 100.0 THEN 1 END) AS fully_successful_tests,
    COUNT(CASE WHEN success_rate < 100.0 THEN 1 END) AS failed_tests
FROM stress_test_run
WHERE created_at >= NOW() - INTERVAL '7 days'
GROUP BY environment
ORDER BY environment;
```

---

## Implementation Guide

### Option 1: Use Prisma (Recommended for this project)

Add to your `schema.prisma`:

```prisma
// Copy the content from stress_test_schema.prisma
```

Then run:
```bash
yarn prisma migrate dev --name add_stress_test_schema
```

### Option 2: Use Raw SQL

Execute the DDL from `stress_test_schema.sql`:

```bash
psql $DATABASE_URL -f stress_test_schema.sql
```

### Option 3: Manual Setup

1. Copy the table definitions
2. Create indexes manually
3. Test with the query examples above

---

## Maintenance

### Archiving Old Data

To keep the table lean, consider archiving tests older than 90 days:

```sql
-- Create archive table (optional)
CREATE TABLE stress_test_run_archive AS
SELECT * FROM stress_test_run
WHERE created_at < NOW() - INTERVAL '90 days';

-- Delete archived rows
DELETE FROM stress_test_run
WHERE created_at < NOW() - INTERVAL '90 days';

-- Reindex
REINDEX TABLE stress_test_run;
```

### Updating Daily Metrics

Run this daily (e.g., via cron):

```sql
INSERT INTO stress_test_metrics_daily (date_utc, environment, total_runs, total_duration_ms_sum, total_bash_commands, total_files_created, total_subagents_spawned, total_web_searches, avg_success_rate, min_success_rate, max_success_rate, avg_duration_ms, min_duration_ms, max_duration_ms)
SELECT
    DATE(start_time AT TIME ZONE 'UTC') AS date_utc,
    environment,
    COUNT(*) AS total_runs,
    SUM(total_duration_ms) AS total_duration_ms_sum,
    SUM(bash_commands_executed) AS total_bash_commands,
    SUM(files_created) AS total_files_created,
    SUM(subagents_spawned) AS total_subagents_spawned,
    SUM(web_searches_performed) AS total_web_searches,
    AVG(success_rate) AS avg_success_rate,
    MIN(success_rate) AS min_success_rate,
    MAX(success_rate) AS max_success_rate,
    AVG(total_duration_ms)::DECIMAL AS avg_duration_ms,
    MIN(total_duration_ms) AS min_duration_ms,
    MAX(total_duration_ms) AS max_duration_ms
FROM stress_test_run
WHERE DATE(start_time AT TIME ZONE 'UTC') = CURRENT_DATE - INTERVAL '1 day'
GROUP BY DATE(start_time AT TIME ZONE 'UTC'), environment
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
    updated_at = NOW();
```

---

## Performance Considerations

### Write Performance
- **BIGINT for IDs**: Allows for millions of test runs without overflow
- **Denormalization**: Avoid expensive JOINs for common queries
- **Deferred aggregation**: Compute daily metrics asynchronously

### Query Performance
- **Covering indexes**: Indexes include all columns needed for common queries
- **Partial indexes**: Failed tests index only queries where `success_rate < 100.0`
- **Composite indexes**: Date + environment for multi-filter queries

### Storage Optimization
- Use `JSONB` only for truly variable metadata (indexed efficiently)
- Archive old records (>90 days) to separate table
- REINDEX periodically to reclaim bloated B-trees

---

## Data Integrity

### Constraints
- `success_rate` between 0.0 and 100.0 (CHECK constraint)
- `total_operations` >= `successful_operations` (CHECK constraint)
- All counts >= 0 (CHECK constraints)
- Unique `test_id` prevents duplicate results

### Foreign Keys
- `stress_test_operation.test_run_id` → `stress_test_run.id` (CASCADE delete)
- Ensures operation records are deleted when test is deleted

---

## Monitoring Queries

### Alert: Degrading Success Rate
```sql
SELECT
    DATE(start_time AT TIME ZONE 'UTC') AS date_utc,
    environment,
    AVG(success_rate) AS avg_success_rate,
    LAG(AVG(success_rate)) OVER (
        PARTITION BY environment
        ORDER BY DATE(start_time AT TIME ZONE 'UTC')
    ) AS prev_day_avg
FROM stress_test_run
WHERE start_time >= NOW() - INTERVAL '30 days'
GROUP BY DATE(start_time AT TIME ZONE 'UTC'), environment
HAVING AVG(success_rate) < 95.0
ORDER BY date_utc DESC;
```

### Alert: Increasing Duration
```sql
SELECT
    DATE(start_time AT TIME ZONE 'UTC') AS date_utc,
    environment,
    AVG(total_duration_ms) AS avg_duration_ms,
    STDDEV_POP(total_duration_ms) AS stddev_duration_ms
FROM stress_test_run
WHERE start_time >= NOW() - INTERVAL '7 days'
GROUP BY DATE(start_time AT TIME ZONE 'UTC'), environment
HAVING AVG(total_duration_ms) > 5000
ORDER BY date_utc DESC;
```

---

## Summary

This schema provides:

✓ **Efficient querying** by date range, environment, and success rate  
✓ **Fast aggregations** with pre-computed daily metrics  
✓ **Operational visibility** with optional detail table  
✓ **Data integrity** through constraints and foreign keys  
✓ **Performance** with strategic indexing  
✓ **Flexibility** with JSONB metadata field  
✓ **Scalability** with BIGINT identifiers and archival capability  
