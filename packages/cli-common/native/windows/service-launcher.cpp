#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shellapi.h>
#include <pathcch.h>

#include <cstdint>
#include <string>
#include <vector>

namespace {

constexpr wchar_t kBuildVersion[] = L"1";
constexpr char kProvenanceMarker[] = "HAPPIER_SERVICE_LAUNCHER_V1";

enum ExitCode : int {
  kOk = 0,
  kInvalidArguments = 10,
  kInvalidWrapper = 11,
  kOpenDiagnosticLogFailed = 12,
  kResolvePowerShellFailed = 13,
  kOpenNullFailed = 14,
  kCreateJobFailed = 15,
  kConfigureJobFailed = 16,
  kCreateProcessFailed = 17,
  kAssignJobFailed = 18,
  kResumeProcessFailed = 19,
  kWaitProcessFailed = 20,
  kReadExitCodeFailed = 21,
  kDisarmJobFailed = 22,
  kConfigureHandleInheritanceFailed = 23,
};

struct Handle {
  HANDLE value = nullptr;
  Handle() = default;
  explicit Handle(HANDLE handle) : value(handle) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  ~Handle() {
    if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value);
  }
  bool valid() const { return value && value != INVALID_HANDLE_VALUE; }
};

std::wstring QuoteArgument(const std::wstring& value) {
  std::wstring result = L"\"";
  size_t backslashes = 0;
  for (const wchar_t ch : value) {
    if (ch == L'\\') {
      ++backslashes;
      continue;
    }
    if (ch == L'\"') {
      result.append(backslashes * 2 + 1, L'\\');
      result.push_back(L'\"');
      backslashes = 0;
      continue;
    }
    result.append(backslashes, L'\\');
    backslashes = 0;
    result.push_back(ch);
  }
  result.append(backslashes * 2, L'\\');
  result.push_back(L'\"');
  return result;
}

bool IsAbsoluteFilePath(const std::wstring& path) {
  if (path.size() < 3) return false;
  for (const wchar_t ch : path) {
    if (ch < 0x20) return false;
  }
  size_t driveStart = 0;
  if (path.starts_with(L"\\\\?\\")) {
    if (path.size() >= 8 && CompareStringOrdinal(path.c_str(), 8, L"\\\\?\\UNC\\", 8, TRUE) == CSTR_EQUAL) {
      return PathIsUNCEx(path.c_str(), nullptr);
    }
    driveStart = 4;
  } else if (path.starts_with(L"\\\\.\\")) {
    return false;
  } else if (PathIsUNCEx(path.c_str(), nullptr)) {
    return true;
  }
  return path.size() >= driveStart + 3
    && ((path[driveStart] >= L'A' && path[driveStart] <= L'Z') || (path[driveStart] >= L'a' && path[driveStart] <= L'z'))
    && path[driveStart + 1] == L':'
    && (path[driveStart + 2] == L'\\' || path[driveStart + 2] == L'/');
}

std::string WideToUtf8(const std::wstring& value) {
  if (value.empty()) return "";
  const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                                         static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (length <= 0) return "";
  std::string result(static_cast<size_t>(length), '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                      static_cast<int>(value.size()), result.data(), length, nullptr, nullptr);
  return result;
}

std::string QuoteLogValue(const std::string& value) {
  std::string result = "\"";
  for (const char ch : value) {
    if (ch == '\\' || ch == '"') result.push_back('\\');
    result.push_back(ch);
  }
  result.push_back('"');
  return result;
}

void WriteUtf8(HANDLE handle, const std::string& value) {
  if (!handle || handle == INVALID_HANDLE_VALUE || value.empty()) return;
  DWORD written = 0;
  WriteFile(handle, value.data(), static_cast<DWORD>(value.size()), &written, nullptr);
}

std::uint64_t FileTimeTicks(const FILETIME& value) {
  ULARGE_INTEGER ticks{};
  ticks.LowPart = value.dwLowDateTime;
  ticks.HighPart = value.dwHighDateTime;
  return ticks.QuadPart;
}

void Log(HANDLE log, const char* stage, const char* message, DWORD error = 0,
         DWORD childExit = STILL_ACTIVE, DWORD wrapperPid = 0,
         std::uint64_t wrapperCreationTime = 0) {
  SYSTEMTIME now{};
  GetSystemTime(&now);
  std::string line = "timestamp=" + std::to_string(now.wYear) + "-" + std::to_string(now.wMonth)
    + "-" + std::to_string(now.wDay) + "T" + std::to_string(now.wHour) + ":"
    + std::to_string(now.wMinute) + ":" + std::to_string(now.wSecond) + "Z"
    + " launcher_version=" + WideToUtf8(kBuildVersion)
    + " provenance=" + kProvenanceMarker
    + " launcher_pid=" + std::to_string(GetCurrentProcessId())
    + " stage=" + stage + " message=" + message;
  if (wrapperPid != 0) line += " wrapper_pid=" + std::to_string(wrapperPid);
  if (wrapperCreationTime != 0) {
    line += " wrapper_creation_filetime=" + std::to_string(wrapperCreationTime);
  }
  if (error != 0) line += " win32_error=" + std::to_string(error);
  if (childExit != STILL_ACTIVE) line += " child_exit=" + std::to_string(childExit);
  line += "\r\n";
  WriteUtf8(log, line);
}

int FailBeforeLog(const char* message, int code) {
  const std::string line = std::string("happier-service-launcher: ") + message + "\r\n";
  WriteUtf8(GetStdHandle(STD_ERROR_HANDLE), line);
  return code;
}

std::wstring ResolvePowerShellPath() {
  std::vector<wchar_t> windows(MAX_PATH + 1);
  const UINT length = GetWindowsDirectoryW(windows.data(), static_cast<UINT>(windows.size()));
  if (length == 0 || length >= windows.size()) return L"";
  std::wstring result(windows.data(), length);
  result += L"\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const DWORD attributes = GetFileAttributesW(result.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY) ? result : L"";
}

}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  int argc = 0;
  LPWSTR* argvRaw = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argvRaw) return FailBeforeLog("unable to parse command line", kInvalidArguments);
  std::vector<std::wstring> argv(argvRaw, argvRaw + argc);
  LocalFree(argvRaw);

  if (argc == 2 && argv[1] == L"--version") {
    WriteUtf8(GetStdHandle(STD_OUTPUT_HANDLE), "happier-service-launcher 1\r\n");
    return kOk;
  }

  std::wstring wrapper;
  std::wstring diagnosticLog;
  for (int index = 1; index < argc; index += 2) {
    if (index + 1 >= argc) return FailBeforeLog("option is missing a value", kInvalidArguments);
    if (argv[index] == L"--wrapper" && wrapper.empty()) {
      wrapper = argv[index + 1];
    } else if (argv[index] == L"--diagnostic-log" && diagnosticLog.empty()) {
      diagnosticLog = argv[index + 1];
    } else {
      return FailBeforeLog("unknown or duplicate option", kInvalidArguments);
    }
  }
  if (!IsAbsoluteFilePath(wrapper) || !IsAbsoluteFilePath(diagnosticLog)) {
    return FailBeforeLog("wrapper and diagnostic log must be fully qualified file paths", kInvalidArguments);
  }
  Handle log(CreateFileW(diagnosticLog.c_str(), FILE_APPEND_DATA,
                         FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                         nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!log.valid()) return FailBeforeLog("unable to open diagnostic log", kOpenDiagnosticLogFailed);
  const std::string acceptedMessage = "accepted wrapper=" + QuoteLogValue(WideToUtf8(wrapper));
  Log(log.value, "parse", acceptedMessage.c_str());

  const DWORD wrapperAttributes = GetFileAttributesW(wrapper.c_str());
  if (wrapperAttributes == INVALID_FILE_ATTRIBUTES || (wrapperAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
    const DWORD error = GetLastError();
    Log(log.value, "validate_wrapper", "failed", error);
    return kInvalidWrapper;
  }

  const std::wstring powershell = ResolvePowerShellPath();
  if (powershell.empty()) {
    Log(log.value, "resolve_powershell", "failed", GetLastError());
    return kResolvePowerShellFailed;
  }

  SECURITY_ATTRIBUTES inheritable{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  Handle nullInput(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                               &inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  Handle nullOutput(CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                &inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!nullInput.valid() || !nullOutput.valid()) {
    Log(log.value, "open_standard_handles", "failed", GetLastError());
    return kOpenNullFailed;
  }

  Handle job(CreateJobObjectW(nullptr, nullptr));
  if (!job.valid()) {
    Log(log.value, "create_job", "failed", GetLastError());
    return kCreateJobFailed;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    Log(log.value, "configure_job", "failed", GetLastError());
    return kConfigureJobFailed;
  }

  std::wstring commandLine = QuoteArgument(powershell)
    + L" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + QuoteArgument(wrapper);
  std::vector<wchar_t> mutableCommand(commandLine.begin(), commandLine.end());
  mutableCommand.push_back(L'\0');

  // Inherit only the two NUL standard handles, never other inheritable handles
  // this launcher may itself have received.
  HANDLE inheritedHandles[] = {nullInput.value, nullOutput.value};
  SIZE_T attributeListSize = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeListSize);
  std::vector<unsigned char> attributeListStorage(attributeListSize);
  auto attributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeListStorage.data());
  if (attributeListSize == 0 || !InitializeProcThreadAttributeList(attributeList, 1, 0, &attributeListSize)) {
    Log(log.value, "configure_handle_inheritance", "failed", GetLastError());
    return kConfigureHandleInheritanceFailed;
  }
  const BOOL handleListSet = UpdateProcThreadAttribute(
    attributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inheritedHandles, sizeof(inheritedHandles),
    nullptr, nullptr);
  if (!handleListSet) {
    const DWORD error = GetLastError();
    DeleteProcThreadAttributeList(attributeList);
    Log(log.value, "configure_handle_inheritance", "failed", error);
    return kConfigureHandleInheritanceFailed;
  }

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = nullInput.value;
  startup.StartupInfo.hStdOutput = nullOutput.value;
  startup.StartupInfo.hStdError = nullOutput.value;
  startup.lpAttributeList = attributeList;
  PROCESS_INFORMATION process{};
  const DWORD flags = CREATE_NO_WINDOW | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT;
  const BOOL processCreated = CreateProcessW(powershell.c_str(), mutableCommand.data(), nullptr, nullptr, TRUE,
                                      flags, nullptr, nullptr, &startup.StartupInfo, &process);
  const DWORD createError = processCreated ? 0 : GetLastError();
  DeleteProcThreadAttributeList(attributeList);
  if (!processCreated) {
    Log(log.value, "create_process", "failed", createError);
    return kCreateProcessFailed;
  }
  Handle childProcess(process.hProcess);
  Handle childThread(process.hThread);
  FILETIME created{}, exited{}, kernel{}, user{};
  const std::uint64_t wrapperCreationTime = GetProcessTimes(
    childProcess.value, &created, &exited, &kernel, &user) ? FileTimeTicks(created) : 0;
  Log(log.value, "create_process", "suspended", 0, STILL_ACTIVE,
      process.dwProcessId, wrapperCreationTime);

  if (!AssignProcessToJobObject(job.value, childProcess.value)) {
    const DWORD error = GetLastError();
    TerminateProcess(childProcess.value, kAssignJobFailed);
    WaitForSingleObject(childProcess.value, 5000);
    Log(log.value, "assign_job", "failed", error, STILL_ACTIVE,
        process.dwProcessId, wrapperCreationTime);
    return kAssignJobFailed;
  }
  if (ResumeThread(childThread.value) == static_cast<DWORD>(-1)) {
    const DWORD error = GetLastError();
    TerminateProcess(childProcess.value, kResumeProcessFailed);
    WaitForSingleObject(childProcess.value, 5000);
    Log(log.value, "resume_process", "failed", error, STILL_ACTIVE,
        process.dwProcessId, wrapperCreationTime);
    return kResumeProcessFailed;
  }
  Log(log.value, "wait_wrapper", "running", 0, STILL_ACTIVE,
      process.dwProcessId, wrapperCreationTime);

  if (WaitForSingleObject(childProcess.value, INFINITE) != WAIT_OBJECT_0) {
    const DWORD error = GetLastError();
    TerminateProcess(childProcess.value, kWaitProcessFailed);
    Log(log.value, "wait_wrapper", "failed", error, STILL_ACTIVE,
        process.dwProcessId, wrapperCreationTime);
    return kWaitProcessFailed;
  }
  DWORD childExit = 0;
  if (!GetExitCodeProcess(childProcess.value, &childExit)) {
    Log(log.value, "read_exit", "failed", GetLastError(), STILL_ACTIVE,
        process.dwProcessId, wrapperCreationTime);
    return kReadExitCodeFailed;
  }

  // A wrapper exit is an observed normal boundary even when its exit code is
  // nonzero. Disarming before the launcher closes the job preserves descendants
  // intentionally retained by daemon shutdown/self-restart. Forced launcher
  // termination never reaches this line, so kill-on-close remains armed.
  limits.BasicLimitInformation.LimitFlags = 0;
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    Log(log.value, "disarm_job", "failed", GetLastError(), childExit,
        process.dwProcessId, wrapperCreationTime);
    return kDisarmJobFailed;
  }
  Log(log.value, "wrapper_exit", "observed", 0, childExit,
      process.dwProcessId, wrapperCreationTime);
  return static_cast<int>(childExit);
}
