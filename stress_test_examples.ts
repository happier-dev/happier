/**
 * Stress Test Schema Usage Examples
 *
 * This module demonstrates how to use the stress test schema with Prisma
 * and PostgreSQL for storing and querying stress test results.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ==============================================================================
// Type Definitions
// ==============================================================================

interface StressTestInput {
  testId?: string;
  startTime: Date;
  endTime: Date;
  bashCommandsExecuted: number;
  filesCreated: number;
  subagentsSpawned: number;
  webSearchesPerformed: number;
  successRate: number; // 0.0 to 100.0
  successfulOperations: number;
  totalOperations: number;
  environment?: string;
  testName?: string;
  testVersion?: string;
}

interface OperationInput {
  operationType: 'bash_command' | 'file_create' | 'subagent_spawn' | 'web_search';
  operationIndex: number;
  operationLabel?: string;
  startTime: Date;
  endTime: Date;
  success: boolean;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

// ==============================================================================
// Core Functions
// ==============================================================================

/**
 * Record a stress test run with all metrics
 */
async function recordStressTestRun(input: StressTestInput) {
  const durationMs = input.endTime.getTime() - input.startTime.getTime();

  const result = await prisma.stressTestRun.create({
    data: {
      testId: input.testId,
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
      bashSuccessCount: Math.floor(
        (input.bashCommandsExecuted * input.successRate) / 100
      ),
      subagentSuccessCount: Math.floor(
        (input.subagentsSpawned * input.successRate) / 100
      ),
      environment: input.environment || 'test',
      testName: input.testName,
      testVersion: input.testVersion,
    },
  });

  return result;
}

/**
 * Record detailed operations for a stress test
 */
async function recordStressTestOperations(
  testRunId: bigint,
  operations: OperationInput[]
) {
  const operationRecords = operations.map((op) => ({
    testRunId,
    operationType: op.operationType,
    operationIndex: op.operationIndex,
    operationLabel: op.operationLabel,
    startTime: op.startTime,
    endTime: op.endTime,
    durationMs: op.endTime.getTime() - op.startTime.getTime(),
    success: op.success,
    errorMessage: op.errorMessage,
    metadata: op.metadata || null,
  }));

  const results = await prisma.stressTestOperation.createMany({
    data: operationRecords,
  });

  return results;
}

// ==============================================================================
// Query Functions
// ==============================================================================

/**
 * Get a test by its business ID
 */
async function getTestById(testId: string) {
  return await prisma.stressTestRun.findUnique({
    where: { testId },
    include: {
      operations: {
        orderBy: { operationIndex: 'asc' },
      },
    },
  });
}

/**
 * Get all tests from the last N hours
 */
async function getRecentTests(hoursAgo: number = 24) {
  const cutoffTime = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);

  return await prisma.stressTestRun.findMany({
    where: {
      startTime: { gte: cutoffTime },
    },
    orderBy: { startTime: 'desc' },
  });
}

/**
 * Get tests within a date range
 */
async function getTestsByDateRange(startDate: Date, endDate: Date) {
  return await prisma.stressTestRun.findMany({
    where: {
      startTime: { gte: startDate },
      endTime: { lte: endDate },
    },
    orderBy: { startTime: 'desc' },
  });
}

/**
 * Find failed tests (success_rate < 100)
 */
async function getFailedTests(limit: number = 50) {
  return await prisma.stressTestRun.findMany({
    where: {
      successRate: { lt: 100.0 },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/**
 * Get tests by environment
 */
async function getTestsByEnvironment(
  environment: string,
  hoursAgo: number = 24
) {
  const cutoffTime = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);

  return await prisma.stressTestRun.findMany({
    where: {
      environment,
      startTime: { gte: cutoffTime },
    },
    orderBy: { startTime: 'desc' },
  });
}

/**
 * Get operations for a specific test
 */
async function getTestOperations(testRunId: bigint) {
  return await prisma.stressTestOperation.findMany({
    where: { testRunId },
    orderBy: { operationIndex: 'asc' },
  });
}

// ==============================================================================
// Aggregation Functions
// ==============================================================================

/**
 * Get daily metrics summary (using raw SQL for complex aggregations)
 */
async function getDailyMetricsSummary(startDate: Date, endDate: Date) {
  const results = await prisma.$queryRaw<
    Array<{
      date_utc: string;
      environment: string;
      total_runs: number;
      total_duration_ms: string;
      avg_duration_ms: string;
      min_duration_ms: number;
      max_duration_ms: number;
      avg_success_rate: string;
      total_bash_commands: string;
      total_files_created: string;
      total_subagents_spawned: string;
      total_web_searches: string;
    }>
  >`
    SELECT
      DATE(start_time AT TIME ZONE 'UTC')::TEXT as date_utc,
      environment,
      COUNT(*) as total_runs,
      SUM(total_duration_ms)::TEXT as total_duration_ms,
      AVG(total_duration_ms)::TEXT as avg_duration_ms,
      MIN(total_duration_ms) as min_duration_ms,
      MAX(total_duration_ms) as max_duration_ms,
      AVG(success_rate)::TEXT as avg_success_rate,
      SUM(bash_commands_executed)::TEXT as total_bash_commands,
      SUM(files_created)::TEXT as total_files_created,
      SUM(subagents_spawned)::TEXT as total_subagents_spawned,
      SUM(web_searches_performed)::TEXT as total_web_searches
    FROM stress_test_run
    WHERE start_time >= ${startDate} AND start_time <= ${endDate}
    GROUP BY DATE(start_time AT TIME ZONE 'UTC'), environment
    ORDER BY date_utc DESC, environment
  `;

  return results;
}

/**
 * Get environment comparison statistics
 */
async function getEnvironmentComparison(days: number = 7) {
  const cutoffTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const results = await prisma.$queryRaw<
    Array<{
      environment: string;
      total_tests: number;
      avg_success_rate: string;
      min_success_rate: string;
      max_success_rate: string;
      avg_duration_ms: string;
      stddev_duration_ms: string;
      fully_successful_tests: number;
      failed_tests: number;
    }>
  >`
    SELECT
      environment,
      COUNT(*) as total_tests,
      AVG(success_rate)::TEXT as avg_success_rate,
      MIN(success_rate)::TEXT as min_success_rate,
      MAX(success_rate)::TEXT as max_success_rate,
      AVG(total_duration_ms)::TEXT as avg_duration_ms,
      STDDEV_POP(total_duration_ms)::TEXT as stddev_duration_ms,
      COUNT(CASE WHEN success_rate = 100.0 THEN 1 END) as fully_successful_tests,
      COUNT(CASE WHEN success_rate < 100.0 THEN 1 END) as failed_tests
    FROM stress_test_run
    WHERE created_at >= ${cutoffTime}
    GROUP BY environment
    ORDER BY environment
  `;

  return results;
}

/**
 * Get operation type breakdown for a test
 */
async function getOperationBreakdown(testRunId: bigint) {
  return await prisma.stressTestOperation.groupBy({
    by: ['operationType'],
    where: { testRunId },
    _count: { id: true },
    _sum: { durationMs: true },
    _avg: { durationMs: true },
    _min: { durationMs: true },
    _max: { durationMs: true },
  });
}

/**
 * Get performance trend (percentiles over time)
 */
async function getPerformanceTrend(days: number = 30, environment?: string) {
  const cutoffTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const whereClause = {
    startTime: { gte: cutoffTime },
    ...(environment && { environment }),
  };

  const results = await prisma.$queryRaw<
    Array<{
      date_utc: string;
      min_duration_ms: number;
      avg_duration_ms: string;
      max_duration_ms: number;
      p50_duration_ms: number;
      p95_duration_ms: number;
      p99_duration_ms: number;
      test_count: number;
    }>
  >`
    SELECT
      DATE(start_time AT TIME ZONE 'UTC')::TEXT as date_utc,
      MIN(total_duration_ms) as min_duration_ms,
      AVG(total_duration_ms)::TEXT as avg_duration_ms,
      MAX(total_duration_ms) as max_duration_ms,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY total_duration_ms) as p50_duration_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_duration_ms) as p95_duration_ms,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY total_duration_ms) as p99_duration_ms,
      COUNT(*) as test_count
    FROM stress_test_run
    WHERE start_time >= ${cutoffTime}
      ${environment ? 'AND environment = ' + `'${environment}'` : ''}
    GROUP BY DATE(start_time AT TIME ZONE 'UTC')
    ORDER BY date_utc DESC
  `;

  return results;
}

// ==============================================================================
// Mutation Functions
// ==============================================================================

/**
 * Update a test's results (if needed for corrections)
 */
async function updateTestResults(testId: string, updates: Partial<StressTestInput>) {
  return await prisma.stressTestRun.update({
    where: { testId },
    data: {
      bashCommandsExecuted: updates.bashCommandsExecuted,
      filesCreated: updates.filesCreated,
      subagentsSpawned: updates.subagentsSpawned,
      webSearchesPerformed: updates.webSearchesPerformed,
      successRate: updates.successRate,
      successfulOperations: updates.successfulOperations,
      totalOperations: updates.totalOperations,
    },
  });
}

/**
 * Delete a test and all its operations (cascade handled by FK)
 */
async function deleteTest(testId: string) {
  return await prisma.stressTestRun.delete({
    where: { testId },
  });
}

// ==============================================================================
// Usage Example
// ==============================================================================

async function exampleUsage() {
  try {
    // 1. Record a stress test run
    const startTime = new Date('2026-06-11T10:00:00Z');
    const endTime = new Date('2026-06-11T10:15:30Z');

    const testRun = await recordStressTestRun({
      startTime,
      endTime,
      bashCommandsExecuted: 50,
      filesCreated: 15,
      subagentsSpawned: 8,
      webSearchesPerformed: 12,
      successRate: 96.5,
      successfulOperations: 77,
      totalOperations: 80,
      environment: 'production',
      testName: 'Daily Smoke Test',
      testVersion: '1.0.0',
    });

    console.log('Test Run Created:', testRun.testId);

    // 2. Record operations for this test
    const operations: OperationInput[] = [
      {
        operationType: 'bash_command',
        operationIndex: 1,
        operationLabel: 'yarn test',
        startTime: new Date('2026-06-11T10:00:00Z'),
        endTime: new Date('2026-06-11T10:02:00Z'),
        success: true,
      },
      {
        operationType: 'subagent_spawn',
        operationIndex: 2,
        operationLabel: 'Database migration check',
        startTime: new Date('2026-06-11T10:02:00Z'),
        endTime: new Date('2026-06-11T10:03:00Z'),
        success: true,
      },
    ];

    await recordStressTestOperations(testRun.id, operations);

    // 3. Query the test
    const retrievedTest = await getTestById(testRun.testId);
    console.log('Retrieved Test:', retrievedTest);

    // 4. Get daily metrics
    const metrics = await getDailyMetricsSummary(
      new Date('2026-06-01'),
      new Date('2026-06-11')
    );
    console.log('Daily Metrics:', metrics);

    // 5. Get environment comparison
    const comparison = await getEnvironmentComparison(7);
    console.log('Environment Comparison:', comparison);

    // 6. Get operation breakdown
    const breakdown = await getOperationBreakdown(testRun.id);
    console.log('Operation Breakdown:', breakdown);

    // 7. Get performance trend
    const trend = await getPerformanceTrend(30, 'production');
    console.log('Performance Trend:', trend);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// ==============================================================================
// Exports
// ==============================================================================

export {
  recordStressTestRun,
  recordStressTestOperations,
  getTestById,
  getRecentTests,
  getTestsByDateRange,
  getFailedTests,
  getTestsByEnvironment,
  getTestOperations,
  getDailyMetricsSummary,
  getEnvironmentComparison,
  getOperationBreakdown,
  getPerformanceTrend,
  updateTestResults,
  deleteTest,
  exampleUsage,
  type StressTestInput,
  type OperationInput,
};
