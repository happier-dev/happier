-- Stress Test Results Schema for PostgreSQL
-- Supports querying by date range and aggregating metrics
-- Created: 2026-06-11

-- Main table for stress test runs
CREATE TABLE stress_test_run (
    -- Identifiers
    id BIGSERIAL PRIMARY KEY,
    test_id UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),

    -- Temporal data
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE NOT NULL,

    -- Duration (computed from end_time - start_time, but stored for query efficiency)
    total_duration_ms INTEGER NOT NULL CHECK (total_duration_ms >= 0),

    -- Metrics
    bash_commands_executed INTEGER NOT NULL CHECK (bash_commands_executed >= 0),
    files_created INTEGER NOT NULL CHECK (files_created >= 0),
    subagents_spawned INTEGER NOT NULL CHECK (subagents_spawned >= 0),
    web_searches_performed INTEGER NOT NULL CHECK (web_searches_performed >= 0),

    -- Success tracking
    success_rate DECIMAL(5, 2) NOT NULL CHECK (success_rate >= 0.0 AND success_rate <= 100.0),

    -- Success count (for aggregations)
    successful_operations INTEGER NOT NULL CHECK (successful_operations >= 0),
    total_operations INTEGER NOT NULL CHECK (total_operations >= successful_operations),

    -- Optional: breakdown by operation type
    bash_success_count INTEGER NOT NULL DEFAULT 0 CHECK (bash_success_count >= 0),
    subagent_success_count INTEGER NOT NULL DEFAULT 0 CHECK (subagent_success_count >= 0),

    -- Metadata
    environment VARCHAR(50) DEFAULT 'test', -- 'test', 'staging', 'production'
    test_name VARCHAR(255),
    test_version VARCHAR(50),

    -- Audit fields
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Primary indexes for common queries
CREATE INDEX idx_stress_test_run_start_time
    ON stress_test_run(start_time DESC);

CREATE INDEX idx_stress_test_run_date_range
    ON stress_test_run(start_time, end_time);

CREATE INDEX idx_stress_test_run_test_id
    ON stress_test_run(test_id);

CREATE INDEX idx_stress_test_run_created_at
    ON stress_test_run(created_at DESC);

-- Composite index for common date-range + environment queries
CREATE INDEX idx_stress_test_run_date_env
    ON stress_test_run(start_time DESC, environment);

-- Index for aggregation queries by environment
CREATE INDEX idx_stress_test_run_environment
    ON stress_test_run(environment, created_at DESC);

-- Partial index for failed tests (success_rate < 100)
CREATE INDEX idx_stress_test_run_failed
    ON stress_test_run(created_at DESC)
    WHERE success_rate < 100.0;

-- Table to track individual operations within a stress test (optional, for detailed analysis)
CREATE TABLE stress_test_operation (
    id BIGSERIAL PRIMARY KEY,
    test_run_id BIGINT NOT NULL REFERENCES stress_test_run(id) ON DELETE CASCADE,

    -- Operation details
    operation_type VARCHAR(50) NOT NULL, -- 'bash_command', 'file_create', 'subagent_spawn', 'web_search'
    operation_index INTEGER NOT NULL,
    operation_label VARCHAR(255),

    -- Timing
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE NOT NULL,
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),

    -- Result
    success BOOLEAN NOT NULL,
    error_message TEXT,

    -- Optional: operation-specific details stored as JSON
    metadata JSONB,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes for operation queries
CREATE INDEX idx_stress_test_operation_test_run_id
    ON stress_test_operation(test_run_id);

CREATE INDEX idx_stress_test_operation_operation_type
    ON stress_test_operation(operation_type);

CREATE INDEX idx_stress_test_operation_success
    ON stress_test_operation(test_run_id, success);

-- Composite index for querying operations by type and time
CREATE INDEX idx_stress_test_operation_type_time
    ON stress_test_operation(operation_type, start_time DESC);

-- Table for aggregated metrics (for performance optimization)
CREATE TABLE stress_test_metrics_daily (
    id BIGSERIAL PRIMARY KEY,

    -- Date grouping
    date_utc DATE NOT NULL,
    environment VARCHAR(50) NOT NULL,

    -- Aggregated counts
    total_runs INTEGER NOT NULL DEFAULT 0 CHECK (total_runs >= 0),
    total_duration_ms_sum BIGINT NOT NULL DEFAULT 0 CHECK (total_duration_ms_sum >= 0),

    total_bash_commands INTEGER NOT NULL DEFAULT 0 CHECK (total_bash_commands >= 0),
    total_files_created INTEGER NOT NULL DEFAULT 0 CHECK (total_files_created >= 0),
    total_subagents_spawned INTEGER NOT NULL DEFAULT 0 CHECK (total_subagents_spawned >= 0),
    total_web_searches INTEGER NOT NULL DEFAULT 0 CHECK (total_web_searches >= 0),

    -- Statistics
    avg_success_rate DECIMAL(5, 2) NOT NULL DEFAULT 0.0 CHECK (avg_success_rate >= 0.0 AND avg_success_rate <= 100.0),
    min_success_rate DECIMAL(5, 2) DEFAULT 100.0,
    max_success_rate DECIMAL(5, 2) DEFAULT 100.0,

    avg_duration_ms DECIMAL(12, 2) DEFAULT 0.0,
    min_duration_ms INTEGER,
    max_duration_ms INTEGER,

    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- Unique constraint ensures one row per date per environment
    UNIQUE (date_utc, environment)
);

-- Indexes for aggregation queries
CREATE INDEX idx_stress_test_metrics_daily_date
    ON stress_test_metrics_daily(date_utc DESC);

CREATE INDEX idx_stress_test_metrics_daily_env
    ON stress_test_metrics_daily(environment, date_utc DESC);

-- Create view for quick metrics queries
CREATE OR REPLACE VIEW stress_test_metrics_summary AS
SELECT
    DATE(start_time AT TIME ZONE 'UTC') AS date_utc,
    environment,
    COUNT(*) AS total_runs,
    SUM(total_duration_ms) AS total_duration_ms,
    AVG(total_duration_ms) AS avg_duration_ms,
    MIN(total_duration_ms) AS min_duration_ms,
    MAX(total_duration_ms) AS max_duration_ms,
    SUM(bash_commands_executed) AS total_bash_commands,
    SUM(files_created) AS total_files_created,
    SUM(subagents_spawned) AS total_subagents_spawned,
    SUM(web_searches_performed) AS total_web_searches,
    AVG(success_rate) AS avg_success_rate,
    MIN(success_rate) AS min_success_rate,
    MAX(success_rate) AS max_success_rate,
    COUNT(CASE WHEN success_rate = 100.0 THEN 1 END) AS fully_successful_runs,
    COUNT(CASE WHEN success_rate < 100.0 THEN 1 END) AS failed_runs
FROM stress_test_run
GROUP BY DATE(start_time AT TIME ZONE 'UTC'), environment;

-- Example queries for common use cases:
--
-- 1. Get all tests from the last 24 hours:
-- SELECT * FROM stress_test_run
-- WHERE start_time >= NOW() - INTERVAL '24 hours'
-- ORDER BY start_time DESC;
--
-- 2. Get metrics for a specific date range:
-- SELECT * FROM stress_test_metrics_summary
-- WHERE date_utc >= '2026-06-01' AND date_utc <= '2026-06-11'
-- ORDER BY date_utc DESC, environment;
--
-- 3. Find failed tests:
-- SELECT test_id, test_name, success_rate, total_duration_ms
-- FROM stress_test_run
-- WHERE success_rate < 100.0
-- ORDER BY created_at DESC;
--
-- 4. Aggregate metrics by environment:
-- SELECT
--     environment,
--     COUNT(*) AS total_runs,
--     AVG(success_rate) AS avg_success_rate,
--     AVG(total_duration_ms) AS avg_duration_ms
-- FROM stress_test_run
-- WHERE start_time >= NOW() - INTERVAL '7 days'
-- GROUP BY environment
-- ORDER BY environment;
--
-- 5. Get operation-level details for a specific test:
-- SELECT
--     operation_type,
--     COUNT(*) AS operation_count,
--     SUM(CASE WHEN success THEN 1 ELSE 0 END) AS successful_count,
--     AVG(duration_ms) AS avg_duration_ms
-- FROM stress_test_operation
-- WHERE test_run_id = (SELECT id FROM stress_test_run WHERE test_id = 'YOUR_TEST_ID')
-- GROUP BY operation_type
-- ORDER BY operation_type;
