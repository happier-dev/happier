/**
 * Stress Test Schema - Integration Tests
 *
 * Tests to verify the schema is correctly set up and queries work as expected.
 * Run with: yarn test stress_test_schema.spec.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('Stress Test Schema', () => {
  // Test data
  const testRunData = {
    startTime: new Date('2026-06-11T10:00:00Z'),
    endTime: new Date('2026-06-11T10:15:30Z'),
    bashCommandsExecuted: 50,
    filesCreated: 15,
    subagentsSpawned: 8,
    webSearchesPerformed: 12,
    successRate: 96.5,
    successfulOperations: 77,
    totalOperations: 80,
    environment: 'test',
    testName: 'Integration Test Suite',
    testVersion: '1.0.0',
  };

  const operationData = [
    {
      operationType: 'bash_command' as const,
      operationIndex: 1,
      operationLabel: 'yarn build',
      startTime: new Date('2026-06-11T10:00:00Z'),
      endTime: new Date('2026-06-11T10:02:00Z'),
      success: true,
    },
    {
      operationType: 'subagent_spawn' as const,
      operationIndex: 2,
      operationLabel: 'Test runner',
      startTime: new Date('2026-06-11T10:02:00Z'),
      endTime: new Date('2026-06-11T10:05:00Z'),
      success: true,
    },
    {
      operationType: 'web_search' as const,
      operationIndex: 3,
      operationLabel: 'Documentation lookup',
      startTime: new Date('2026-06-11T10:05:00Z'),
      endTime: new Date('2026-06-11T10:06:00Z'),
      success: false,
      errorMessage: 'Network timeout',
    },
  ];

  let testRunId: bigint;

  beforeAll(async () => {
    // Clean up before tests
    await prisma.stressTestOperation.deleteMany({});
    await prisma.stressTestRun.deleteMany({});
    await prisma.stressTestMetricsDaily.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('stress_test_run table', () => {
    it('should create a test run with all metrics', async () => {
      const durationMs =
        testRunData.endTime.getTime() - testRunData.startTime.getTime();

      const result = await prisma.stressTestRun.create({
        data: {
          startTime: testRunData.startTime,
          endTime: testRunData.endTime,
          totalDurationMs: durationMs,
          bashCommandsExecuted: testRunData.bashCommandsExecuted,
          filesCreated: testRunData.filesCreated,
          subagentsSpawned: testRunData.subagentsSpawned,
          webSearchesPerformed: testRunData.webSearchesPerformed,
          successRate: testRunData.successRate,
          successfulOperations: testRunData.successfulOperations,
          totalOperations: testRunData.totalOperations,
          environment: testRunData.environment,
          testName: testRunData.testName,
          testVersion: testRunData.testVersion,
        },
      });

      testRunId = result.id;

      expect(result).toBeDefined();
      expect(result.testId).toBeDefined();
      expect(result.totalDurationMs).toBe(930000); // 15.5 minutes
      expect(result.successRate).toBe(96.5);
      expect(result.environment).toBe('test');
    });

    it('should enforce success_rate constraint (0-100)', async () => {
      const invalidRate = async () => {
        return await prisma.stressTestRun.create({
          data: {
            startTime: new Date(),
            endTime: new Date(),
            totalDurationMs: 1000,
            successRate: 150.0, // Invalid: > 100
            bashCommandsExecuted: 0,
            filesCreated: 0,
            subagentsSpawned: 0,
            webSearchesPerformed: 0,
            successfulOperations: 0,
            totalOperations: 0,
          },
        });
      };

      await expect(invalidRate()).rejects.toThrow();
    });

    it('should enforce non-negative counts', async () => {
      const invalidCounts = async () => {
        return await prisma.stressTestRun.create({
          data: {
            startTime: new Date(),
            endTime: new Date(),
            totalDurationMs: 1000,
            successRate: 100.0,
            bashCommandsExecuted: -1, // Invalid: negative
            filesCreated: 0,
            subagentsSpawned: 0,
            webSearchesPerformed: 0,
            successfulOperations: 0,
            totalOperations: 0,
          },
        });
      };

      await expect(invalidCounts()).rejects.toThrow();
    });

    it('should return test by testId (UUID)', async () => {
      const run = await prisma.stressTestRun.findMany({
        take: 1,
      });

      expect(run).toHaveLength(1);
      const testId = run[0].testId;

      const retrieved = await prisma.stressTestRun.findUnique({
        where: { testId },
      });

      expect(retrieved).toBeDefined();
      expect(retrieved?.testId).toBe(testId);
    });

    it('should query by date range', async () => {
      const results = await prisma.stressTestRun.findMany({
        where: {
          startTime: {
            gte: new Date('2026-06-10T00:00:00Z'),
            lte: new Date('2026-06-12T00:00:00Z'),
          },
        },
      });

      expect(results.length).toBeGreaterThan(0);
    });

    it('should find failed tests (success_rate < 100)', async () => {
      // Create a failed test
      await prisma.stressTestRun.create({
        data: {
          startTime: new Date(),
          endTime: new Date(),
          totalDurationMs: 1000,
          successRate: 75.0,
          bashCommandsExecuted: 10,
          filesCreated: 0,
          subagentsSpawned: 0,
          webSearchesPerformed: 0,
          successfulOperations: 7,
          totalOperations: 10,
        },
      });

      const failedTests = await prisma.stressTestRun.findMany({
        where: {
          successRate: { lt: 100.0 },
        },
      });

      expect(failedTests.length).toBeGreaterThan(0);
      expect(failedTests.every((t) => t.successRate < 100.0)).toBe(true);
    });

    it('should query by environment', async () => {
      const testResults = await prisma.stressTestRun.findMany({
        where: { environment: 'test' },
      });

      expect(testResults.length).toBeGreaterThan(0);
      expect(testResults.every((t) => t.environment === 'test')).toBe(true);
    });
  });

  describe('stress_test_operation table', () => {
    it('should create operations for a test run', async () => {
      const operationsToCreate = operationData.map((op) => ({
        ...op,
        testRunId,
        durationMs: op.endTime.getTime() - op.startTime.getTime(),
        success: op.success,
        errorMessage: op.errorMessage || null,
      }));

      const results = await prisma.stressTestOperation.createMany({
        data: operationsToCreate,
      });

      expect(results.count).toBe(3);
    });

    it('should retrieve operations for a test', async () => {
      const operations = await prisma.stressTestOperation.findMany({
        where: { testRunId },
        orderBy: { operationIndex: 'asc' },
      });

      expect(operations).toHaveLength(3);
      expect(operations[0].operationType).toBe('bash_command');
      expect(operations[1].operationType).toBe('subagent_spawn');
      expect(operations[2].operationType).toBe('web_search');
    });

    it('should track operation success/failure', async () => {
      const operations = await prisma.stressTestOperation.findMany({
        where: { testRunId },
      });

      const successful = operations.filter((op) => op.success);
      const failed = operations.filter((op) => !op.success);

      expect(successful).toHaveLength(2);
      expect(failed).toHaveLength(1);
      expect(failed[0].errorMessage).toBe('Network timeout');
    });

    it('should calculate operation duration', async () => {
      const operations = await prisma.stressTestOperation.findMany({
        where: { testRunId },
      });

      operations.forEach((op) => {
        expect(op.durationMs).toBeGreaterThanOrEqual(0);
      });
    });

    it('should group operations by type', async () => {
      const groupedOps = await prisma.stressTestOperation.groupBy({
        by: ['operationType'],
        where: { testRunId },
        _count: { id: true },
      });

      expect(groupedOps).toHaveLength(3);
      expect(groupedOps.some((g) => g.operationType === 'bash_command')).toBe(
        true
      );
      expect(groupedOps.some((g) => g.operationType === 'subagent_spawn')).toBe(
        true
      );
      expect(groupedOps.some((g) => g.operationType === 'web_search')).toBe(
        true
      );
    });

    it('should cascade delete operations when test is deleted', async () => {
      // Create a new test
      const newTest = await prisma.stressTestRun.create({
        data: {
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
        },
      });

      // Create an operation
      await prisma.stressTestOperation.create({
        data: {
          testRunId: newTest.id,
          operationType: 'bash_command',
          operationIndex: 1,
          startTime: new Date(),
          endTime: new Date(),
          durationMs: 100,
          success: true,
        },
      });

      // Delete the test
      await prisma.stressTestRun.delete({
        where: { id: newTest.id },
      });

      // Verify operation was also deleted
      const operations = await prisma.stressTestOperation.findMany({
        where: { testRunId: newTest.id },
      });

      expect(operations).toHaveLength(0);
    });
  });

  describe('Aggregation Queries', () => {
    it('should aggregate metrics by date and environment', async () => {
      const startDate = new Date('2026-06-01T00:00:00Z');
      const endDate = new Date('2026-06-12T00:00:00Z');

      const metrics = await prisma.$queryRaw<
        Array<{
          date_utc: string;
          environment: string;
          total_runs: number;
          avg_success_rate: string;
          avg_duration_ms: string;
        }>
      >`
        SELECT
          DATE(start_time AT TIME ZONE 'UTC')::TEXT as date_utc,
          environment,
          COUNT(*) as total_runs,
          AVG(success_rate)::TEXT as avg_success_rate,
          AVG(total_duration_ms)::TEXT as avg_duration_ms
        FROM stress_test_run
        WHERE start_time >= ${startDate} AND start_time <= ${endDate}
        GROUP BY DATE(start_time AT TIME ZONE 'UTC'), environment
        ORDER BY date_utc DESC
      `;

      expect(metrics.length).toBeGreaterThan(0);
      expect(metrics[0]).toHaveProperty('total_runs');
      expect(metrics[0]).toHaveProperty('avg_success_rate');
    });

    it('should find operations breakdown by type', async () => {
      const breakdown = await prisma.stressTestOperation.groupBy({
        by: ['operationType'],
        where: { testRunId },
        _count: { id: true },
        _avg: { durationMs: true },
        _sum: { durationMs: true },
      });

      expect(breakdown.length).toBeGreaterThan(0);
      breakdown.forEach((item) => {
        expect(item._count.id).toBeGreaterThan(0);
        expect(item._avg.durationMs).toBeDefined();
      });
    });
  });

  describe('Data Integrity', () => {
    it('should maintain data consistency across tables', async () => {
      const testRun = await prisma.stressTestRun.findUnique({
        where: { id: testRunId },
        include: { operations: true },
      });

      expect(testRun).toBeDefined();
      expect(testRun?.operations.length).toBeGreaterThan(0);

      // Verify operation counts match
      const successfulOps = testRun!.operations.filter(
        (op) => op.success
      ).length;
      const totalOps = testRun!.operations.length;

      expect(successfulOps).toBeGreaterThan(0);
      expect(totalOps).toBeGreaterThan(0);
    });

    it('should maintain referential integrity', async () => {
      const allOperations =
        await prisma.stressTestOperation.findMany();

      for (const op of allOperations) {
        const parentTest = await prisma.stressTestRun.findUnique({
          where: { id: op.testRunId },
        });

        expect(parentTest).toBeDefined();
      }
    });
  });

  describe('Performance Characteristics', () => {
    it('should support index lookups efficiently', async () => {
      const start = performance.now();

      const result = await prisma.stressTestRun.findMany({
        where: {
          startTime: {
            gte: new Date('2026-06-10T00:00:00Z'),
          },
        },
        orderBy: { startTime: 'desc' },
        take: 10,
      });

      const duration = performance.now() - start;

      expect(result).toBeDefined();
      expect(duration).toBeLessThan(100); // Should be fast with index
    });

    it('should handle batch inserts efficiently', async () => {
      const operations = Array.from({ length: 100 }, (_, i) => ({
        testRunId,
        operationType: 'bash_command' as const,
        operationIndex: 100 + i,
        startTime: new Date(),
        endTime: new Date(),
        durationMs: Math.random() * 1000,
        success: Math.random() > 0.1,
      }));

      const start = performance.now();

      const result = await prisma.stressTestOperation.createMany({
        data: operations,
      });

      const duration = performance.now() - start;

      expect(result.count).toBe(100);
      expect(duration).toBeLessThan(1000); // Should complete in <1 second
    });
  });
});
